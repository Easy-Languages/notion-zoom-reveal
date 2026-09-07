import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const privateDatabaseId = process.env.NOTION_PRIVATE_DATABASE_ID;
const publicDatabaseId = process.env.NOTION_PUBLIC_DATABASE_ID;

const DATE_TIME_PROPERTY = "Uhrzeit bei dir";
const HIDDEN_LINK_PROPERTY = "link-zum-call-hidden";
const VISIBLE_LINK_PROPERTY = "Link zum Call";

const MINUTES_BEFORE = 15;
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
    if (!publicPage) continue;

    const eventTime = new Date(dateTime);
    const differenceInMinutes = (eventTime.getTime() - now.getTime()) / 60000;

    const hiddenLink = getUrlOrText(privatePage.properties[HIDDEN_LINK_PROPERTY]);
    const currentVisibleLink = getUrlOrText(publicPage.properties[VISIBLE_LINK_PROPERTY]);
    const visibleLinkType = publicPage.properties[VISIBLE_LINK_PROPERTY]?.type || "url";

    const shouldReveal =
      differenceInMinutes <= MINUTES_BEFORE && differenceInMinutes > -MINUTES_AFTER_CLEANUP;

    if (shouldReveal && hiddenLink && currentVisibleLink !== hiddenLink) {
      await notion.pages.update({
        page_id: publicPage.id,
        properties: { [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, hiddenLink) },
      });
    }

    if (differenceInMinutes <= -MINUTES_AFTER_CLEANUP && currentVisibleLink) {
      await notion.pages.update({
        page_id: publicPage.id,
        properties: { [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, CLEANUP_TEXT) },
      });
    }
  }
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await run();
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}