import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const privateDatabaseId = process.env.NOTION_PRIVATE_DATABASE_ID;
const publicDatabaseId = process.env.NOTION_PUBLIC_DATABASE_ID;

// Adjust these to match the actual column names in both databases
const DATE_TIME_PROPERTY = "Uhrzeit bei dir";              // exists in both databases
const HIDDEN_LINK_PROPERTY = "link-zum-call-hidden"; // private database only
const VISIBLE_LINK_PROPERTY = "Link zum Call";       // public database only

const MINUTES_BEFORE = 30;
const MINUTES_AFTER_CLEANUP = 120;

const CLEANUP_TEXT = "Call beendet";

function getUrlOrText(prop) {
  if (!prop) return "";
  if (prop.type === "url") return prop.url || "";
  if (prop.type === "rich_text") return prop.rich_text?.[0]?.plain_text || "";
  return "";
}

function buildPropValue(type, value) {
  if (type === "url") return { url: value || null };
  return { rich_text: value ? [{ text: { content: value } }] : [] };
}

function getPageTitle(page) {
  const titleProp = Object.values(page.properties).find((p) => p.type === "title");
  return titleProp?.title?.[0]?.plain_text?.trim() || "";
}

// Unique key used to match rows between the two databases
function matchKey(title, dateTimeIso) {
  return `${title}__${dateTimeIso}`;
}

async function fetchAllPages(databaseId) {
  let results = [];
  let cursor = undefined;
  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    results = results.concat(response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function run() {
  const now = new Date();

  const [privatePages, publicPages] = await Promise.all([
    fetchAllPages(privateDatabaseId),
    fetchAllPages(publicDatabaseId),
  ]);

  // Build an index of the public database by key (title + date/time)
  const publicByKey = new Map();
  for (const page of publicPages) {
    const title = getPageTitle(page);
    const dateTime = page.properties[DATE_TIME_PROPERTY]?.date?.start;
    if (!title || !dateTime) continue;
    publicByKey.set(matchKey(title, dateTime), page);
  }

  for (const privatePage of privatePages) {
    const title = getPageTitle(privatePage);
    const dateTime = privatePage.properties[DATE_TIME_PROPERTY]?.date?.start;
    if (!title || !dateTime) continue;

    const publicPage = publicByKey.get(matchKey(title, dateTime));
    if (!publicPage) {
      console.warn(`No matching row in the public database for: "${title}" (${dateTime})`);
      continue;
    }

    const eventTime = new Date(dateTime);
    const differenceInMinutes = (eventTime.getTime() - now.getTime()) / 60000;

    const hiddenLink = getUrlOrText(privatePage.properties[HIDDEN_LINK_PROPERTY]);
    const currentVisibleLink = getUrlOrText(publicPage.properties[VISIBLE_LINK_PROPERTY]);
    const visibleLinkType = publicPage.properties[VISIBLE_LINK_PROPERTY]?.type || "url";

    const shouldReveal =
      differenceInMinutes <= MINUTES_BEFORE && differenceInMinutes > -MINUTES_AFTER_CLEANUP;

    if (shouldReveal && hiddenLink && currentVisibleLink !== hiddenLink) {
      console.log(`Revealing link for "${title}" at ${eventTime.toISOString()}`);
      await notion.pages.update({
        page_id: publicPage.id,
        properties: {
          [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, hiddenLink),
        },
      });
    }

    if (differenceInMinutes <= -MINUTES_AFTER_CLEANUP && currentVisibleLink) {
      console.log(`Clearing link for "${title}" (event has passed)`);
      await notion.pages.update({
        page_id: publicPage.id,
        properties: {
          [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, CLEANUP_TEXT),
        },
      });
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});