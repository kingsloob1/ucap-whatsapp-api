/**
 * The Flow JSON of InvestNow's three WhatsApp Flows. `bun run flows` uploads
 * them to Meta; the chat simulator renders the same JSON. Every screen is
 * served by the Flow endpoint (data API 3.0), which validates each answer
 * before the next screen opens, so the rules live in one place: the server.
 *
 * Inputs that are secret are `password` fields, masked as they are typed, and
 * listed in each screen's `sensitive`, so WhatsApp masks them in the summary
 * it shows after the form closes too.
 */
import { BVN_USSD } from "../conversation/conversation.constants";
import { MIN_AGE } from "../conversation/parsers";
import type { FlowDefinition, FlowName } from "./flows.interface";

const VERSION = "7.2";
const DATA_API_VERSION = "3.0";

const str = (example: string) => ({ type: "string", __example__: example });
const bool = (example: boolean) => ({ type: "boolean", __example__: example });
const options = (example: { id: string; title: string }[]) => ({
  type: "array",
  items: {
    type: "object",
    properties: { id: { type: "string" }, title: { type: "string" } },
  },
  __example__: example,
});

const layout = (...children: Record<string, unknown>[]) => ({
  type: "SingleColumnLayout",
  children,
});

const footer = (label: string, payload: Record<string, string>) => ({
  type: "Footer",
  label,
  "on-click-action": { name: "data_exchange", payload },
});

const pinInput = (name: string, label: string, helper?: string) => ({
  type: "TextInput",
  name,
  label,
  "input-type": "password",
  required: true,
  "min-chars": 4,
  "max-chars": 4,
  ...(helper ? { "helper-text": helper } : {}),
  "error-message": `\${data.${name}_error}`,
});

/** The PIN screen the PIN and transaction Flows end on. */
const approveScreen = {
  id: "PIN",
  title: "Approve",
  terminal: true,
  data: {
    summary: str("Fund your wallet with ₦50,000.00"),
    pin_error: str(""),
  },
  sensitive: ["pin"],
  layout: layout(
    { type: "TextHeading", text: "Approve with your PIN" },
    { type: "TextBody", text: "${data.summary}" },
    pinInput("pin", "Transaction PIN"),
    footer("Approve", { pin: "${form.pin}" }),
  ),
};

export const FLOW_DEFINITIONS: Record<FlowName, FlowDefinition> = {
  onboarding: {
    version: VERSION,
    data_api_version: DATA_API_VERSION,
    // An answer changed after the review (with the back arrow) returns straight
    // to it once every answer is in.
    routing_model: {
      BVN: ["DOB", "REVIEW"],
      DOB: ["PRODUCTS", "REVIEW"],
      PRODUCTS: ["PIN", "REVIEW"],
      PIN: ["REVIEW"],
      REVIEW: [],
    },
    screens: [
      {
        id: "BVN",
        title: "Your BVN",
        data: { bvn_error: str("") },
        sensitive: ["bvn"],
        layout: layout(
          { type: "TextHeading", text: "Step 1 of 4: your BVN" },
          {
            type: "TextBody",
            text:
              "Enter your 11-digit Bank Verification Number. Don't know it? " +
              `Dial ${BVN_USSD} from the phone number linked to your bank account.`,
          },
          {
            type: "TextInput",
            name: "bvn",
            label: "BVN",
            "input-type": "password",
            required: true,
            "min-chars": 11,
            "max-chars": 11,
            "helper-text": "11 digits, starting with 22",
            "error-message": "${data.bvn_error}",
          },
          footer("Continue", { bvn: "${form.bvn}" }),
        ),
      },
      {
        id: "DOB",
        title: "Date of birth",
        data: {
          min_date: str("1906-01-01"),
          max_date: str("2021-01-01"),
          dob_error: str(""),
        },
        layout: layout(
          { type: "TextHeading", text: "Step 2 of 4: date of birth" },
          {
            type: "DatePicker",
            name: "dob",
            label: "Date of birth",
            required: true,
            "min-date": "${data.min_date}",
            "max-date": "${data.max_date}",
            "helper-text": `You must be at least ${MIN_AGE} years old`,
            "error-message": "${data.dob_error}",
          },
          footer("Continue", { dob: "${form.dob}" }),
        ),
      },
      {
        id: "PRODUCTS",
        title: "Products",
        data: {
          products: options([{ id: "MMF", title: "Money Market Fund" }]),
        },
        layout: layout(
          { type: "TextHeading", text: "Step 3 of 4: products" },
          {
            type: "TextBody",
            text: "Which products are you interested in? Choose one or more.",
          },
          {
            type: "CheckboxGroup",
            name: "products",
            label: "Products",
            required: true,
            "min-selected-items": 1,
            "data-source": "${data.products}",
          },
          footer("Continue", { products: "${form.products}" }),
        ),
      },
      {
        id: "PIN",
        title: "Your PIN",
        data: { pin_error: str(""), pin_confirm_error: str("") },
        sensitive: ["pin", "pin_confirm"],
        layout: layout(
          { type: "TextHeading", text: "Step 4 of 4: transaction PIN" },
          {
            type: "TextBody",
            text: "Create a 4-digit PIN. You'll use it to approve transactions and view balances.",
          },
          pinInput(
            "pin",
            "New PIN",
            "Not 1234, 1111, 1212 or your date of birth",
          ),
          pinInput("pin_confirm", "Confirm PIN"),
          footer("Continue", {
            pin: "${form.pin}",
            pin_confirm: "${form.pin_confirm}",
          }),
        ),
      },
      {
        id: "REVIEW",
        title: "Review",
        terminal: true,
        data: {
          bvn_masked: str("•••••••4455"),
          dob_text: str("25/12/1990"),
          products_text: str("Money Market Fund, Stocks"),
        },
        layout: layout(
          { type: "TextHeading", text: "Review your details" },
          { type: "TextSubheading", text: "BVN" },
          { type: "TextBody", text: "${data.bvn_masked}" },
          { type: "TextSubheading", text: "Date of birth" },
          { type: "TextBody", text: "${data.dob_text}" },
          { type: "TextSubheading", text: "Products" },
          { type: "TextBody", text: "${data.products_text}" },
          { type: "TextSubheading", text: "PIN" },
          { type: "TextBody", text: "••••" },
          {
            type: "TextCaption",
            text: "To change anything, tap the back arrow. Your account is created when you tap Create account.",
          },
          footer("Create account", { confirm: "yes" }),
        ),
      },
    ],
  },

  pin: {
    version: VERSION,
    data_api_version: DATA_API_VERSION,
    routing_model: { PIN: [] },
    screens: [approveScreen],
  },

  transaction: {
    version: VERSION,
    data_api_version: DATA_API_VERSION,
    routing_model: { AMOUNT: ["PIN"], PIN: [] },
    screens: [
      {
        id: "AMOUNT",
        title: "InvestNow",
        data: {
          heading: str("Fund your wallet"),
          details: str("Wallet balance: ₦0.00"),
          choose_product: bool(false),
          products: options([{ id: "MMF", title: "Money Market Fund" }]),
          amount_error: str(""),
        },
        layout: layout(
          { type: "TextHeading", text: "${data.heading}" },
          { type: "TextBody", text: "${data.details}" },
          {
            type: "RadioButtonsGroup",
            name: "product",
            label: "Product",
            required: false,
            visible: "${data.choose_product}",
            "data-source": "${data.products}",
          },
          {
            type: "TextInput",
            name: "amount",
            label: "Amount (₦)",
            "input-type": "number",
            required: true,
            "helper-text": "From ₦100 to ₦10,000,000, e.g. 5000",
            "error-message": "${data.amount_error}",
          },
          footer("Continue", {
            product: "${form.product}",
            amount: "${form.amount}",
          }),
        ),
      },
      approveScreen,
    ],
  },
};
