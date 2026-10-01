import type { Channel } from "./gemini-api";

/**
 * Fixed scenarios for the Settings → "Test prompt" run. Each one is fed through
 * the live prompt (SYSTEM_PROMPT + learned guidelines) on two models so a prompt
 * or model change can be eyeballed for regressions before it ships. Order
 * numbers are real — the Shopify lookups they trigger are read-only.
 */
export interface EvalScenario {
  id: string;
  name: string;
  channel: Channel;
  customerName?: string;
  customerEmail?: string;
  orderNumber?: string;
  messages: { sender: "user" | "agent"; text: string }[];
  /** One line on what a good reply does — shown next to the drafts. */
  expect: string;
}

const user = (text: string) => [{ sender: "user" as const, text }];

export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: "status-transit-us",
    name: "Status — in transit (US)",
    channel: "email",
    customerName: "Sam",
    orderNumber: "29363",
    messages: user("Hi, where is my order #29363? It's been over a week."),
    expect: "Latest scan in plain words + tracking link; USPS handles the final leg.",
  },
  {
    id: "status-delivered-au",
    name: "Status — delivered (AU)",
    channel: "email",
    customerName: "Mia",
    orderNumber: "29359",
    messages: user("Hey has my order 29359 shipped yet?"),
    expect: "Says the day it was delivered, left in a safe place, asks them to confirm.",
  },
  {
    id: "delivered-not-received",
    name: "Delivered but not received",
    channel: "email",
    customerName: "Josh",
    orderNumber: "29361",
    messages: user("Tracking says my order 29361 was delivered but I never got it. What now?"),
    expect: "Check around the property/neighbours; USPS inquiry before any replacement.",
  },
  {
    id: "defect-no-photo",
    name: "Defect — no photo",
    channel: "email",
    customerName: "Ollie",
    messages: user("Hi, the number 7 started peeling after 2 games. Not happy."),
    expect: "Apologise, ask for a photo + order number; no discount offered.",
  },
  {
    id: "missing-item",
    name: "Missing item",
    channel: "email",
    customerName: "Kim",
    messages: user("Hello, I only got 2 of the 4 crosses I ordered."),
    expect: "Asks for a photo of what arrived.",
  },
  {
    id: "address-change",
    name: "Address change",
    channel: "email",
    customerName: "Cristina",
    orderNumber: "20160",
    messages: user(
      "I forgot to change the shipping address on order 20160, it should be 351 Concord Rd, Glen Mills, PA 19342"
    ),
    expect: "Short \"updated\" (or already shipped → can't); doesn't restate the address; update_address action.",
  },
  {
    id: "discount-request",
    name: "Discount request",
    channel: "email",
    customerName: "Ben",
    messages: user("Any chance of a discount code? Ordering 3 flags"),
    expect: "No individual discounts; mentions the price breaks.",
  },
  {
    id: "unsupported-country",
    name: "Unsupported country",
    channel: "email",
    customerName: "Ana",
    messages: user("Do you ship to Brazil?"),
    expect: "Scripted not-available line, with a greeting.",
  },
  {
    id: "knit-boots",
    name: "Knit boots",
    channel: "email",
    customerName: "Alex",
    messages: user("Will these work on Nike Phantom GX 2 Elite? The upper is Flyknit"),
    expect: "Not on knit; says which areas work; boot checker link.",
  },
  {
    id: "praise",
    name: "Praise",
    channel: "email",
    customerName: "Guy",
    messages: user("Got them today and they look amazing. Great service, thanks!"),
    expect: "Thanks + Shop review line + link.",
  },
  {
    id: "club-bulk-quote",
    name: "Club bulk quote",
    channel: "email",
    customerName: "Lilydale Eagles",
    messages: user("We'd like 60 transfers of our club logo, can you quote?"),
    expect: "\"Hi there,\" (not the club name); price breaks, custom image, sample photos.",
  },
  {
    id: "ig-greeting",
    name: "IG — pure greeting",
    channel: "instagram",
    messages: user("hola"),
    expect: "Scripted greeting, in Spanish.",
  },
  {
    id: "ig-spanish-question",
    name: "IG — Spanish question",
    channel: "instagram",
    messages: user("Hola! cuánto cuesta enviar a España y cuánto tarda?"),
    expect: "Answers in Spanish; no links.",
  },
  {
    id: "ig-content-share",
    name: "IG — content share",
    channel: "instagram",
    messages: user("Look how sick my boots look with the bootink 🔥🔥 [Customer attached an image]"),
    expect: "Thanks/compliment; create_discount action; doesn't promise a code later.",
  },
  {
    id: "ig-wants-product",
    name: "IG — wants product",
    channel: "instagram",
    messages: user("how do i get my name and number on my boots"),
    expect: "Points to the Names/Numbers pages; link in bio.",
  },
];

/** Models offered in the test modal (the saved model is added if missing). */
export const EVAL_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];
