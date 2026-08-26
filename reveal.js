import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// Adjust these names to match your Notion database columns EXACTLY
const DATE_TIME_PROPERTY = "date-hour";      // Date-type property
const HIDDEN_LINK_PROPERTY = "call-url-hidden";  // URL or Text-type property
const VISIBLE_LINK_PROPERTY = "call-url"; // URL or Text-type property

const MINUTES_BEFORE = 10;      // reveals the link X minutes before
const MINUTES_AFTER_CLEANUP = 120; // hides it again X minutes after the start (optional)

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

async function run() {
  const now = new Date();

  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: DATE_TIME_PROPERTY,
      date: { is_not_empty: true },
    },
  });

  for (const page of response.results) {
    const props = page.properties;
    const dateTime = props[DATE_TIME_PROPERTY]?.date?.start;
    if (!dateTime) continue;

    const eventTime = new Date(dateTime);
    const differenceInMinutes = (eventTime.getTime() - now.getTime()) / 60000;

    const hiddenLink = getUrlOrText(props[HIDDEN_LINK_PROPERTY]);
    const currentVisibleLink = getUrlOrText(props[VISIBLE_LINK_PROPERTY]);
    const visibleLinkType = props[VISIBLE_LINK_PROPERTY]?.type || "url";

    // Reveals the link between MINUTES_BEFORE and the event time
    const shouldReveal = differenceInMinutes <= MINUTES_BEFORE && differenceInMinutes > -MINUTES_AFTER_CLEANUP;

    if (shouldReveal && hiddenLink && currentVisibleLink !== hiddenLink) {
      console.log(`Revealing link for event at ${eventTime.toISOString()}`);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, hiddenLink),
        },
      });
    }

    // Hides it again after the event has passed
    if (differenceInMinutes <= -MINUTES_AFTER_CLEANUP && currentVisibleLink) {
      console.log(`Cleaning up link for event that has passed (${eventTime.toISOString()})`);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          [VISIBLE_LINK_PROPERTY]: buildPropValue(visibleLinkType, ""),
        },
      });
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});