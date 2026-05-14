import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://api.webflow.com/v2';
const DEFAULT_OUTPUT = 'data.json';

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optionalList = (name, fallback) =>
  (process.env[name] ?? fallback)
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

const token = requiredEnv('WEBFLOW_TOKEN');
const recipesCollectionId = requiredEnv('WEBFLOW_RECIPES_COLLECTION_ID');
const productsCollectionId = requiredEnv('WEBFLOW_PRODUCTS_COLLECTION_ID');
const outputPath = process.env.SEARCH_INDEX_OUTPUT ?? DEFAULT_OUTPUT;

const recipeTitleFields = optionalList('WEBFLOW_RECIPE_TITLE_FIELDS', 'name,title');
const recipeImageFields = optionalList('WEBFLOW_RECIPE_IMAGE_FIELDS', 'main-image,image,thumbnail,photo,imagen');
const productTitleFields = optionalList('WEBFLOW_PRODUCT_TITLE_FIELDS', 'name,title');
const productWeightFields = optionalList('WEBFLOW_PRODUCT_WEIGHT_FIELDS', 'weight,peso,size');
const productImageFields = optionalList('WEBFLOW_PRODUCT_IMAGE_FIELDS', 'main-image,image,thumbnail,photo,imagen');

const getField = (fieldData, keys, fallback = '') => {
  for (const key of keys) {
    const value = fieldData?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    if (value?.url) return value.url;
    if (Array.isArray(value) && value[0]?.url) return value[0].url;
  }
  return fallback;
};

const normalizeCmsItem = (item, config) => {
  const fieldData = item.fieldData ?? {};
  const slug = fieldData.slug || item.slug || item.id;

  return {
    type: config.type,
    title: getField(fieldData, config.titleFields),
    slug,
    weight: getField(fieldData, config.weightFields ?? []),
    image: getField(fieldData, config.imageFields),
  };
};

const listLiveItems = async (collectionId) => {
  const items = [];
  const limit = 100;

  for (let offset = 0; ; offset += limit) {
    const url = new URL(`${API_BASE}/collections/${collectionId}/items/live`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Webflow API error ${response.status} for collection ${collectionId}: ${body}`);
    }

    const json = await response.json();
    const pageItems = json.items ?? [];
    items.push(...pageItems);

    const pagination = json.pagination;
    const total = pagination?.total;
    if (!pageItems.length || (typeof total === 'number' && items.length >= total)) break;
  }

  return items;
};

const uniqueByTypeAndSlug = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.title || !item.slug) return false;
    const key = `${item.type}:${item.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const main = async () => {
  const [recipes, products] = await Promise.all([
    listLiveItems(recipesCollectionId),
    listLiveItems(productsCollectionId),
  ]);

  const indexItems = uniqueByTypeAndSlug([
    ...recipes.map((item) =>
      normalizeCmsItem(item, {
        type: 'recipe',
        titleFields: recipeTitleFields,
        imageFields: recipeImageFields,
      }),
    ),
    ...products.map((item) =>
      normalizeCmsItem(item, {
        type: 'product',
        titleFields: productTitleFields,
        weightFields: productWeightFields,
        imageFields: productImageFields,
      }),
    ),
  ]).sort((a, b) => a.title.localeCompare(b.title, 'es'));

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(`${outputPath}.tmp`, `${JSON.stringify(indexItems, null, 2)}\n`);
  await fs.rename(`${outputPath}.tmp`, outputPath);

  console.log(`Wrote ${indexItems.length} search items to ${outputPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
