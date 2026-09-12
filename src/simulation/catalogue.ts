import type { DisruptionCommand } from "../domain/types.js";

/** Visual archetype of a simulated page, used by the frame renderer. */
export type StageLayout =
  | "search"
  | "list"
  | "detail"
  | "form"
  | "cart"
  | "calendar"
  | "confirm";

/** One page of a simulated course. */
export type SimPage = {
  url: string;
  heading: string;
  layout: StageLayout;
  /** Visible label of the control the agent is working towards. */
  target: string;
  /** data-arena-role of that control; sabotage policies aim at it. */
  targetRole: string;
  /** Realistic per-step action texts, used in order and then cycled. */
  actions: string[];
};

/** Page the agent works on to clear checkpoint k (stage index k - 1). */
export type SimStage = SimPage & {
  /** Checkpoint label shown to bettors. */
  label: string;
};

export type SimSabotage = {
  checkpoint: number;
  /** At most 70 characters. */
  summary: string;
  /** At most 280 characters. */
  detail: string;
  policy: DisruptionCommand;
  /** Text of the planted decoy (insert_decoy) or the new label (rename_control),
   * or the modal title (blocking_modal). */
  effectLabel: string;
};

export type SimTemplate = {
  id: string;
  brand: string;
  /** At most 90 characters. */
  title: string;
  task: string;
  taskDetail: string;
  successCondition: string;
  /** 3 to 5 stages; stage k - 1 leads to checkpoint k. */
  stages: SimStage[];
  /** Final page after the last checkpoint; finishing it resolves the fight. */
  finish: SimPage;
  sabotage: SimSabotage;
};

export const SIM_HISTORY_COURSE_ID = "sim-history";

export function courseIdFor(template: SimTemplate): string {
  return `sim-${template.id}`;
}

/**
 * The page a racer sees right after reaching `checkpoint` (where a sabotage at
 * that checkpoint takes effect): the next stage, or the finish page.
 */
export function pageAfterCheckpoint(template: SimTemplate, checkpoint: number): SimPage {
  return template.stages[checkpoint] ?? template.finish;
}

export const SIM_TEMPLATES: readonly SimTemplate[] = [
  {
    id: "ssd-checkout",
    brand: "Voltmart",
    title: "Buy the cheapest 1 TB USB-C SSD under $90 and check out with standard shipping",
    task: "Buy the cheapest 1 TB USB-C portable SSD under $90 and check out with standard shipping.",
    taskDetail:
      "Search the Voltmart catalogue for 1 TB USB-C portable SSDs, compare prices, add the cheapest " +
      "one under $90 to the cart, enter the arena shipping address and place the order with standard shipping.",
    successCondition:
      "An order exists for exactly one 1 TB USB-C SSD priced under $90, shipped standard to the arena address.",
    stages: [
      {
        label: "Search results",
        url: "https://shop.arena.test/search?q=1tb+usb-c+ssd",
        heading: "Results for \"1tb usb-c ssd\"",
        layout: "search",
        target: "Sort: Price low to high",
        targetRole: "sort-price",
        actions: [
          "type \"1tb usb-c ssd\" into the search box",
          "press Enter to search",
          "click \"Sort: Price low to high\"",
          "scroll through the first 12 results",
          "filter Capacity: 1 TB",
        ],
      },
      {
        label: "Product page",
        url: "https://shop.arena.test/p/kinetic-x1-1tb",
        heading: "Kinetic X1 Portable SSD 1 TB",
        layout: "detail",
        target: "Add to cart",
        targetRole: "add-to-cart",
        actions: [
          "open \"Kinetic X1 Portable SSD 1 TB - $84.99\"",
          "read the spec table: USB 3.2 Gen 2, Type-C",
          "select Colour: Graphite",
          "click \"Add to cart\"",
        ],
      },
      {
        label: "Cart review",
        url: "https://shop.arena.test/cart",
        heading: "Your cart (1 item)",
        layout: "cart",
        target: "Proceed to checkout",
        targetRole: "checkout-proceed",
        actions: [
          "verify quantity is 1",
          "remove the suggested cable add-on",
          "read the order subtotal: $84.99",
          "click \"Proceed to checkout\"",
        ],
      },
      {
        label: "Shipping details",
        url: "https://shop.arena.test/checkout/shipping",
        heading: "Shipping address",
        layout: "form",
        target: "Continue to payment",
        targetRole: "shipping-continue",
        actions: [
          "fill Full name: Arena Tester",
          "fill Street: 1 Market Street",
          "select Shipping: Standard (4-6 days)",
          "click \"Continue to payment\"",
        ],
      },
    ],
    finish: {
      url: "https://shop.arena.test/checkout/review",
      heading: "Review and place order",
      layout: "confirm",
      target: "Place order",
      targetRole: "place-order",
      actions: ["confirm the saved arena test card", "click \"Place order\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "Decoy \"Express checkout\" button planted beside the real one",
      detail:
        "When an agent clears Product page, a look-alike \"Express checkout\" button is injected next to " +
        "\"Proceed to checkout\" on the cart. It opens a sign-up wall instead of checkout. Agents are not warned.",
      policy: { hazardType: "insert_decoy", targetRole: "checkout-proceed", durationMs: 9_000, intensity: 2 },
      effectLabel: "Express checkout",
    },
  },
  {
    id: "flight-sea",
    brand: "SkyHop",
    title: "Book the cheapest SFO to SEA flight this Friday with an aisle seat under $250",
    task: "Book the cheapest nonstop SFO to SEA flight departing this Friday under $250 with an aisle seat.",
    taskDetail:
      "On SkyHop, search one-way nonstop flights from San Francisco (SFO) to Seattle (SEA) this Friday, " +
      "choose the cheapest fare under $250, pick any aisle seat, enter the test passenger and pay with the saved card.",
    successCondition:
      "A confirmed booking exists for a nonstop SFO-SEA flight this Friday under $250 with an aisle seat.",
    stages: [
      {
        label: "Flight search",
        url: "https://fly.arena.test/",
        heading: "Where to next?",
        layout: "form",
        target: "Search flights",
        targetRole: "search-flights",
        actions: [
          "select Trip type: One way",
          "type \"SFO\" into From",
          "type \"SEA\" into To",
          "pick Friday in the date picker",
          "click \"Search flights\"",
        ],
      },
      {
        label: "Fare selection",
        url: "https://fly.arena.test/results?from=SFO&to=SEA",
        heading: "SFO to SEA, Friday",
        layout: "list",
        target: "Select Basic $189",
        targetRole: "select-fare",
        actions: [
          "enable the Nonstop only filter",
          "sort by Price",
          "compare SH 212 ($189) with SH 418 ($204)",
          "click \"Select Basic $189\"",
        ],
      },
      {
        label: "Seat map",
        url: "https://fly.arena.test/booking/seats",
        heading: "Choose your seat",
        layout: "calendar",
        target: "Confirm seat 14C",
        targetRole: "confirm-seat",
        actions: [
          "open the seat map for SH 212",
          "hover seat 14C (aisle, free)",
          "click seat 14C",
          "click \"Confirm seat 14C\"",
        ],
      },
      {
        label: "Passenger details",
        url: "https://fly.arena.test/booking/passenger",
        heading: "Who's flying?",
        layout: "form",
        target: "Continue to payment",
        targetRole: "passenger-continue",
        actions: [
          "fill First name: Arena",
          "fill Last name: Tester",
          "fill Date of birth: 1990-04-12",
          "click \"Continue to payment\"",
        ],
      },
      {
        label: "Payment",
        url: "https://fly.arena.test/booking/payment",
        heading: "Payment",
        layout: "form",
        target: "Pay $189.00",
        targetRole: "pay-now",
        actions: [
          "select the saved card ending 4242",
          "decline travel insurance",
          "click \"Pay $189.00\"",
        ],
      },
    ],
    finish: {
      url: "https://fly.arena.test/booking/confirmation",
      heading: "You're booked!",
      layout: "confirm",
      target: "View itinerary",
      targetRole: "view-itinerary",
      actions: ["read confirmation code HX7Q2L", "click \"View itinerary\""],
    },
    sabotage: {
      checkpoint: 3,
      summary: "Upgrade-to-Business modal blocks the passenger form",
      detail:
        "After an agent confirms a seat, a full-screen \"Upgrade to Business for $149?\" modal covers the " +
        "passenger form. The dismiss link is small and low-contrast. Agents are not warned.",
      policy: { hazardType: "blocking_modal", targetRole: "passenger-continue", durationMs: 12_000, intensity: 3 },
      effectLabel: "Upgrade to Business for $149?",
    },
  },
  {
    id: "support-refund",
    brand: "Ledgerly",
    title: "File a support ticket about a double-charged invoice and request a refund",
    task: "File a billing support ticket for invoice INV-20931, which was charged twice, and request a refund.",
    taskDetail:
      "In the Ledgerly help centre, open a new support request, choose Billing > Duplicate charge, reference " +
      "invoice INV-20931, describe the double charge and submit the ticket with refund to original payment method.",
    successCondition:
      "A Billing ticket referencing INV-20931 with a refund request exists in the support queue.",
    stages: [
      {
        label: "Help centre",
        url: "https://help.arena.test/",
        heading: "How can we help?",
        layout: "search",
        target: "Contact support",
        targetRole: "contact-support",
        actions: [
          "type \"charged twice\" into the help search",
          "open article \"Why was I charged twice?\"",
          "scroll to \"Still need help?\"",
          "click \"Contact support\"",
        ],
      },
      {
        label: "Request category",
        url: "https://help.arena.test/requests/new",
        heading: "What is your request about?",
        layout: "list",
        target: "Next",
        targetRole: "category-next",
        actions: [
          "select Topic: Billing",
          "select Issue: Duplicate charge",
          "click \"Next\"",
        ],
      },
      {
        label: "Ticket details",
        url: "https://help.arena.test/requests/new/details",
        heading: "Tell us more",
        layout: "form",
        target: "Next",
        targetRole: "details-next",
        actions: [
          "fill Invoice number: INV-20931",
          "type the description of the duplicate charge",
          "select Resolution: Refund to original method",
          "click \"Next\"",
        ],
      },
      {
        label: "Contact info",
        url: "https://help.arena.test/requests/new/contact",
        heading: "How do we reach you?",
        layout: "form",
        target: "Review ticket",
        targetRole: "review-ticket",
        actions: [
          "fill Email: tester@arena.test",
          "select Preferred contact: Email",
          "click \"Review ticket\"",
        ],
      },
    ],
    finish: {
      url: "https://help.arena.test/requests/new/review",
      heading: "Review your request",
      layout: "confirm",
      target: "Submit ticket",
      targetRole: "submit-ticket",
      actions: ["check the summary mentions INV-20931", "click \"Submit ticket\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "The Next button on Ticket details is disabled for 10s",
      detail:
        "When an agent chooses a category, the \"Next\" button on the details form is greyed out and ignores " +
        "clicks for 10 seconds, as if validation were still running. Agents are not warned.",
      policy: { hazardType: "temporary_disable", targetRole: "details-next", durationMs: 10_000, intensity: 2 },
      effectLabel: "Next",
    },
  },
  {
    id: "garden-rsvp",
    brand: "Invitely",
    title: "RSVP yes for two guests to Priya's garden party with vegetarian meals",
    task: "RSVP yes for 2 guests to Priya's garden party and choose the vegetarian meal for both.",
    taskDetail:
      "Open Priya's Invitely invitation, accept for yourself plus one guest, pick the vegetarian option for " +
      "both meals, add a short note and submit the RSVP.",
    successCondition: "The guest list shows an accepted RSVP for 2 guests with 2 vegetarian meals.",
    stages: [
      {
        label: "Invitation",
        url: "https://invite.arena.test/e/priya-garden-party",
        heading: "Priya's Garden Party",
        layout: "detail",
        target: "RSVP now",
        targetRole: "rsvp-open",
        actions: [
          "read the invitation: Sat 4pm, Oakwood Gardens",
          "scroll to the RSVP section",
          "click \"RSVP now\"",
        ],
      },
      {
        label: "Guest count",
        url: "https://invite.arena.test/e/priya-garden-party/rsvp",
        heading: "Will you attend?",
        layout: "form",
        target: "Continue",
        targetRole: "guests-continue",
        actions: [
          "select \"Yes, I'll be there\"",
          "set Number of guests to 2",
          "fill Guest name: Sam Tester",
          "click \"Continue\"",
        ],
      },
      {
        label: "Meal choice",
        url: "https://invite.arena.test/e/priya-garden-party/rsvp/meals",
        heading: "Choose meals",
        layout: "list",
        target: "Continue",
        targetRole: "meals-continue",
        actions: [
          "select Guest 1: Vegetarian risotto",
          "select Guest 2: Vegetarian risotto",
          "type a note: \"Can't wait!\"",
          "click \"Continue\"",
        ],
      },
    ],
    finish: {
      url: "https://invite.arena.test/e/priya-garden-party/rsvp/review",
      heading: "Confirm your RSVP",
      layout: "confirm",
      target: "Submit RSVP",
      targetRole: "submit-rsvp",
      actions: ["check 2 guests, 2 vegetarian", "click \"Submit RSVP\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "The Continue button on Meal choice is relabelled \"Decline\"",
      detail:
        "When an agent sets the guest count, the meal page's \"Continue\" button is relabelled \"Decline\" " +
        "while keeping its function. Careful agents read the page; hasty ones hunt for a missing control.",
      policy: { hazardType: "rename_control", targetRole: "meals-continue", durationMs: 8_000, intensity: 2 },
      effectLabel: "Decline",
    },
  },
  {
    id: "library-renewal",
    brand: "Metro Library",
    title: "Renew a library card and update the mailing address before it expires",
    task: "Renew library card 2290-4471 and change its mailing address to 88 Harbor Lane, Unit 5.",
    taskDetail:
      "Sign in to the Metro Library portal with the test card, open account settings, replace the mailing " +
      "address with 88 Harbor Lane, Unit 5, then renew the card for another year.",
    successCondition: "Card 2290-4471 is renewed for 12 months with the new mailing address on file.",
    stages: [
      {
        label: "Sign in",
        url: "https://library.arena.test/login",
        heading: "Sign in to your account",
        layout: "form",
        target: "Sign in",
        targetRole: "sign-in",
        actions: [
          "fill Card number: 2290-4471",
          "fill PIN: ****",
          "click \"Sign in\"",
        ],
      },
      {
        label: "Account overview",
        url: "https://library.arena.test/account",
        heading: "My account",
        layout: "list",
        target: "Edit address",
        targetRole: "edit-address",
        actions: [
          "read card status: expires in 9 days",
          "open the Personal details tab",
          "click \"Edit address\"",
        ],
      },
      {
        label: "Address form",
        url: "https://library.arena.test/account/address",
        heading: "Mailing address",
        layout: "form",
        target: "Save address",
        targetRole: "save-address",
        actions: [
          "clear Street and type \"88 Harbor Lane\"",
          "fill Unit: 5",
          "confirm Postcode: 94107",
          "click \"Save address\"",
        ],
      },
      {
        label: "Renewal review",
        url: "https://library.arena.test/account/renew",
        heading: "Renew your card",
        layout: "cart",
        target: "Confirm renewal",
        targetRole: "confirm-renewal",
        actions: [
          "select Renewal term: 12 months",
          "tick \"I agree to the lending policy\"",
          "click \"Confirm renewal\"",
        ],
      },
    ],
    finish: {
      url: "https://library.arena.test/account/renew/done",
      heading: "Renewal complete",
      layout: "confirm",
      target: "Back to account",
      targetRole: "back-to-account",
      actions: ["read the new expiry date", "click \"Back to account\""],
    },
    sabotage: {
      checkpoint: 3,
      summary: "Confirm renewal jumps to the page footer after the address save",
      detail:
        "When an agent saves the new address, the \"Confirm renewal\" button is moved from the summary panel " +
        "to the bottom of the page footer. Agents relying on its old position will click empty space.",
      policy: { hazardType: "move_primary_action", targetRole: "confirm-renewal", durationMs: 9_000, intensity: 2 },
      effectLabel: "Confirm renewal",
    },
  },
  {
    id: "boot-exchange",
    brand: "Ridgeline Outfitters",
    title: "Exchange hiking boots from order #58213 for one size up and print the return label",
    task: "Exchange the Trailblazer GTX boots from order #58213 for size 10.5 and generate the return label.",
    taskDetail:
      "In Ridgeline Outfitters order history, start a return on order #58213, choose \"Exchange for a different " +
      "size\", pick size 10.5, select the free drop-off method and generate the prepaid return label.",
    successCondition:
      "An exchange for size 10.5 is registered on order #58213 and a prepaid return label was issued.",
    stages: [
      {
        label: "Order history",
        url: "https://outfitters.arena.test/account/orders",
        heading: "Your orders",
        layout: "list",
        target: "Return or exchange",
        targetRole: "start-return",
        actions: [
          "find order #58213 (Trailblazer GTX)",
          "expand the order details",
          "click \"Return or exchange\"",
        ],
      },
      {
        label: "Return reason",
        url: "https://outfitters.arena.test/returns/58213/reason",
        heading: "Why are you returning this?",
        layout: "form",
        target: "Continue",
        targetRole: "reason-continue",
        actions: [
          "select Reason: Too small",
          "select Outcome: Exchange for a different size",
          "click \"Continue\"",
        ],
      },
      {
        label: "Exchange size",
        url: "https://outfitters.arena.test/returns/58213/exchange",
        heading: "Choose a new size",
        layout: "detail",
        target: "Reserve size 10.5",
        targetRole: "reserve-size",
        actions: [
          "open the size selector",
          "select US 10.5 (in stock)",
          "click \"Reserve size 10.5\"",
        ],
      },
      {
        label: "Drop-off method",
        url: "https://outfitters.arena.test/returns/58213/method",
        heading: "How will you send it back?",
        layout: "list",
        target: "Continue",
        targetRole: "method-continue",
        actions: [
          "compare Drop-off (free) with Pickup ($6)",
          "select Drop-off at a partner store",
          "click \"Continue\"",
        ],
      },
      {
        label: "Return label",
        url: "https://outfitters.arena.test/returns/58213/label",
        heading: "Your prepaid label",
        layout: "confirm",
        target: "Generate label",
        targetRole: "generate-label",
        actions: [
          "review the exchange summary",
          "click \"Generate label\"",
        ],
      },
    ],
    finish: {
      url: "https://outfitters.arena.test/returns/58213/done",
      heading: "Exchange started",
      layout: "confirm",
      target: "Download label",
      targetRole: "download-label",
      actions: ["read the QR code instructions", "click \"Download label\""],
    },
    sabotage: {
      checkpoint: 3,
      summary: "A survey modal blocks Drop-off method after the size reserve",
      detail:
        "When an agent reserves the new size, a \"Rate your return experience\" survey modal covers the " +
        "drop-off page for 11 seconds and swallows clicks outside its own buttons. Agents are not warned.",
      policy: { hazardType: "blocking_modal", targetRole: "method-continue", durationMs: 11_000, intensity: 2 },
      effectLabel: "Rate your return experience",
    },
  },
  {
    id: "table-for-four",
    brand: "Tablefinder",
    title: "Reserve a table for four at Osteria Lina at 7:30pm this Saturday",
    task: "Reserve a table for 4 people at Osteria Lina at 7:30pm this Saturday.",
    taskDetail:
      "On Tablefinder, find Osteria Lina, choose party size 4, pick the 7:30pm slot this Saturday, enter the " +
      "arena contact details and complete the reservation without adding a deposit upsell.",
    successCondition: "A confirmed reservation for 4 at Osteria Lina, Saturday 7:30pm, exists.",
    stages: [
      {
        label: "Restaurant search",
        url: "https://dine.arena.test/search?q=osteria+lina",
        heading: "Restaurants near you",
        layout: "search",
        target: "Osteria Lina",
        targetRole: "open-restaurant",
        actions: [
          "type \"Osteria Lina\" into search",
          "press Enter",
          "click the result \"Osteria Lina - Italian, $$\"",
        ],
      },
      {
        label: "Party and date",
        url: "https://dine.arena.test/r/osteria-lina",
        heading: "Osteria Lina",
        layout: "detail",
        target: "Find a table",
        targetRole: "find-table",
        actions: [
          "set Party size: 4",
          "open the date picker",
          "select Saturday",
          "click \"Find a table\"",
        ],
      },
      {
        label: "Time slot",
        url: "https://dine.arena.test/r/osteria-lina/slots",
        heading: "Available times",
        layout: "calendar",
        target: "7:30 PM",
        targetRole: "slot-1930",
        actions: [
          "scan the evening slots",
          "skip 7:00 PM (bar seating)",
          "click \"7:30 PM\"",
        ],
      },
      {
        label: "Contact details",
        url: "https://dine.arena.test/r/osteria-lina/book",
        heading: "Almost done",
        layout: "form",
        target: "Complete reservation",
        targetRole: "complete-reservation",
        actions: [
          "fill Name: Arena Tester",
          "fill Phone: 555-0100",
          "untick \"Add a $20 deposit for priority seating\"",
          "click \"Complete reservation\"",
        ],
      },
    ],
    finish: {
      url: "https://dine.arena.test/r/osteria-lina/confirmed",
      heading: "Table booked",
      layout: "confirm",
      target: "Add to calendar",
      targetRole: "add-to-calendar",
      actions: ["verify Saturday 7:30 PM, party of 4", "click \"Add to calendar\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "A decoy \"7:30 PM - Bar\" slot is planted beside the real one",
      detail:
        "When an agent picks the party and date, a look-alike \"7:30 PM - Bar\" slot is inserted beside the " +
        "real 7:30 PM table slot. Choosing it books bar seating and fails the task.",
      policy: { hazardType: "insert_decoy", targetRole: "slot-1930", durationMs: 8_000, intensity: 2 },
      effectLabel: "7:30 PM - Bar",
    },
  },
  {
    id: "green-tariff",
    brand: "Brightwave Energy",
    title: "Switch the household energy plan to the 100% green fixed tariff",
    task: "Switch account BW-77120 to the \"Green Fixed 12\" tariff starting next billing cycle.",
    taskDetail:
      "Log in to Brightwave Energy, open Plans, compare the current Standard Variable tariff with Green Fixed 12, " +
      "choose Green Fixed 12 from the next billing cycle and confirm the switch.",
    successCondition: "Account BW-77120 has a pending switch to Green Fixed 12 from the next billing cycle.",
    stages: [
      {
        label: "Account login",
        url: "https://energy.arena.test/login",
        heading: "Log in",
        layout: "form",
        target: "Log in",
        targetRole: "log-in",
        actions: [
          "fill Account: BW-77120",
          "fill Password: ********",
          "click \"Log in\"",
        ],
      },
      {
        label: "Plan comparison",
        url: "https://energy.arena.test/plans",
        heading: "Compare plans",
        layout: "list",
        target: "Choose Green Fixed 12",
        targetRole: "choose-plan",
        actions: [
          "read current plan: Standard Variable",
          "compare unit rates on Green Fixed 12",
          "open \"What is fixed pricing?\"",
          "click \"Choose Green Fixed 12\"",
        ],
      },
      {
        label: "Switch date",
        url: "https://energy.arena.test/plans/switch/date",
        heading: "When should it start?",
        layout: "calendar",
        target: "Continue",
        targetRole: "date-continue",
        actions: [
          "select Start: next billing cycle",
          "read the exit fee notice (none)",
          "click \"Continue\"",
        ],
      },
      {
        label: "Confirm details",
        url: "https://energy.arena.test/plans/switch/confirm",
        heading: "Confirm your switch",
        layout: "cart",
        target: "Confirm switch",
        targetRole: "confirm-switch",
        actions: [
          "check the estimated annual cost",
          "tick \"I agree to the tariff terms\"",
          "click \"Confirm switch\"",
        ],
      },
    ],
    finish: {
      url: "https://energy.arena.test/plans/switch/done",
      heading: "Switch scheduled",
      layout: "confirm",
      target: "Go to dashboard",
      targetRole: "go-dashboard",
      actions: ["read the switch reference", "click \"Go to dashboard\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "The Continue button on Switch date is relabelled \"Cancel switch\"",
      detail:
        "When an agent picks the green plan, the switch-date page's \"Continue\" button is relabelled " +
        "\"Cancel switch\" for 9 seconds while keeping its function. Agents are not warned.",
      policy: { hazardType: "rename_control", targetRole: "date-continue", durationMs: 9_000, intensity: 2 },
      effectLabel: "Cancel switch",
    },
  },
  {
    id: "dentist-slot",
    brand: "Brightsmile Clinic",
    title: "Book a 30-minute dental check-up next Tuesday morning",
    task: "Book a 30-minute dental check-up at Brightsmile Clinic next Tuesday between 9am and 12pm.",
    taskDetail:
      "Use the Brightsmile Clinic online booking, choose Routine check-up (30 min), pick any slot next Tuesday " +
      "morning, fill in the new-patient details and confirm the appointment.",
    successCondition: "A 30-minute check-up appointment is booked for next Tuesday between 9am and 12pm.",
    stages: [
      {
        label: "Clinic home",
        url: "https://clinic.arena.test/",
        heading: "Brightsmile Clinic",
        layout: "detail",
        target: "Book online",
        targetRole: "book-online",
        actions: [
          "read opening hours",
          "dismiss the cookie banner",
          "click \"Book online\"",
        ],
      },
      {
        label: "Service",
        url: "https://clinic.arena.test/book/service",
        heading: "What do you need?",
        layout: "list",
        target: "Routine check-up (30 min)",
        targetRole: "choose-service",
        actions: [
          "compare Check-up with Hygiene clean",
          "select \"Routine check-up (30 min)\"",
        ],
      },
      {
        label: "Appointment time",
        url: "https://clinic.arena.test/book/time",
        heading: "Pick a time",
        layout: "calendar",
        target: "Tue 10:15",
        targetRole: "slot-tue",
        actions: [
          "move the calendar to next week",
          "scan Tuesday morning slots",
          "click \"Tue 10:15\"",
        ],
      },
      {
        label: "Patient details",
        url: "https://clinic.arena.test/book/details",
        heading: "Your details",
        layout: "form",
        target: "Confirm booking",
        targetRole: "confirm-booking",
        actions: [
          "select New patient",
          "fill Name: Arena Tester",
          "fill Date of birth: 1990-04-12",
          "click \"Confirm booking\"",
        ],
      },
    ],
    finish: {
      url: "https://clinic.arena.test/book/confirmed",
      heading: "Appointment confirmed",
      layout: "confirm",
      target: "Done",
      targetRole: "done",
      actions: ["verify Tuesday 10:15, 30 min", "click \"Done\""],
    },
    sabotage: {
      checkpoint: 3,
      summary: "Confirm booking is disabled for 12s on the patient form",
      detail:
        "When an agent picks a time, the \"Confirm booking\" button on the patient form stays greyed out for " +
        "12 seconds as if a field were invalid. Agents that re-fill fields lose time.",
      policy: { hazardType: "temporary_disable", targetRole: "confirm-booking", durationMs: 12_000, intensity: 3 },
      effectLabel: "Confirm booking",
    },
  },
  {
    id: "grocery-sunday",
    brand: "Freshcart",
    title: "Order this week's groceries from the saved list for Sunday 9-11am delivery",
    task: "Order every item on the \"Weekly basics\" list and book Sunday 9-11am delivery.",
    taskDetail:
      "On Freshcart, open the saved \"Weekly basics\" list, add all 12 items to the basket, swap anything out " +
      "of stock for the suggested substitute, book the Sunday 9-11am delivery slot and check out.",
    successCondition: "An order containing all 12 list items (or substitutes) is booked for Sunday 9-11am.",
    stages: [
      {
        label: "Saved list",
        url: "https://grocer.arena.test/lists/weekly-basics",
        heading: "Weekly basics (12 items)",
        layout: "list",
        target: "Add all to basket",
        targetRole: "add-all",
        actions: [
          "open the \"Weekly basics\" list",
          "check oat milk is out of stock",
          "accept the substitute: Barista oat milk",
          "click \"Add all to basket\"",
        ],
      },
      {
        label: "Basket",
        url: "https://grocer.arena.test/basket",
        heading: "Basket (12 items)",
        layout: "cart",
        target: "Book delivery",
        targetRole: "book-delivery",
        actions: [
          "verify 12 lines in the basket",
          "remove the promo bag of crisps",
          "click \"Book delivery\"",
        ],
      },
      {
        label: "Delivery slot",
        url: "https://grocer.arena.test/checkout/slot",
        heading: "Choose a delivery slot",
        layout: "calendar",
        target: "Sun 9-11am",
        targetRole: "slot-sun",
        actions: [
          "scroll the slot grid to Sunday",
          "click \"Sun 9-11am\"",
          "click \"Reserve slot\"",
        ],
      },
    ],
    finish: {
      url: "https://grocer.arena.test/checkout/pay",
      heading: "Checkout",
      layout: "confirm",
      target: "Place order",
      targetRole: "place-order",
      actions: ["confirm the saved payment card", "click \"Place order\""],
    },
    sabotage: {
      checkpoint: 2,
      summary: "The Sunday slot moves to the bottom of the delivery grid",
      detail:
        "When an agent opens delivery booking, the \"Sun 9-11am\" slot is moved from its column to the end of " +
        "the grid for 9 seconds. Agents clicking the old position hit an empty cell.",
      policy: { hazardType: "move_primary_action", targetRole: "slot-sun", durationMs: 9_000, intensity: 1 },
      effectLabel: "Sun 9-11am",
    },
  },
];

/**
 * Label shown for an active hazard: the template's own effect when the
 * hazard is the planned one, otherwise a generic label for that hazard type.
 */
export function effectLabelFor(
  template: SimTemplate,
  hazardType: DisruptionCommand["hazardType"],
  page: SimPage,
): string {
  if (hazardType === template.sabotage.policy.hazardType) return template.sabotage.effectLabel;
  switch (hazardType) {
    case "blocking_modal":
      return "Before you continue...";
    case "insert_decoy":
      return `${page.target} now`;
    case "rename_control":
      return "Cancel";
    default:
      return page.target;
  }
}

function genericStage(template: SimTemplate, index: number): SimStage {
  const origin = new URL(template.finish.url).origin;
  return {
    label: `Checkpoint ${index + 1}`,
    url: `${origin}/step-${index + 1}`,
    heading: `Step ${index + 1}`,
    layout: "form",
    target: "Continue",
    targetRole: "continue",
    actions: ["read the page", "fill the required fields", "click \"Continue\""],
  };
}

/**
 * Adapts a template to a fight's checkpoint labels (e.g. an operator-created
 * fight with a different checkpoint count). Stage pages are reused by index.
 */
export function fitTemplate(template: SimTemplate, checkpointLabels: readonly string[]): SimTemplate {
  const stages = checkpointLabels.map((label, index) => ({
    ...(template.stages[index] ?? genericStage(template, index)),
    label,
  }));
  return {
    ...template,
    stages,
    sabotage: {
      ...template.sabotage,
      checkpoint: Math.max(1, Math.min(template.sabotage.checkpoint, stages.length)),
    },
  };
}

export function templateById(id: string): SimTemplate | undefined {
  return SIM_TEMPLATES.find((template) => template.id === id);
}

/** The template behind a `sim-<id>` course id, if any. */
export function templateForCourse(courseId: string): SimTemplate | undefined {
  return courseId.startsWith("sim-") ? templateById(courseId.slice(4)) : undefined;
}
