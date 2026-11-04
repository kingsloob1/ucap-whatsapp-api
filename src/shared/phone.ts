/**
 * Phone number validation, shared by the API and the chat UI, with the
 * `phone` package: a number is valid only when its length and mobile prefix
 * match its country's (WhatsApp accounts are mobile numbers).
 */
import { countryPhoneData, phone } from "phone";
import type { CountryCode, CountryOption, PhoneCheck } from "./phone.interface";

const BY_ALPHA2 = new Map(countryPhoneData.map((c) => [c.alpha2, c]));

/**
 * Validates `input` as a mobile number. A number starting with `+` (or `00`)
 * carries its own country; any other is read as a national number of `defaultCountry`.
 */
export function checkMobile(
  input: string,
  defaultCountry: CountryCode = "NG",
): PhoneCheck {
  const value = input.trim().replace(/^00/, "+");
  if (value === "") return { ok: false, error: "Enter your phone number." };
  if (/[^\d\s()+.-]/.test(value))
    return { ok: false, error: "A phone number may only contain digits." };
  if (value.lastIndexOf("+") > 0)
    return { ok: false, error: "A + may only start the number." };

  const international = value.startsWith("+");
  const result = phone(value, international ? {} : { country: defaultCountry });
  if (!result.isValid) {
    const country =
      BY_ALPHA2.get(defaultCountry)?.country_name ?? defaultCountry;
    return {
      ok: false,
      error: international
        ? "That isn't a valid mobile number."
        : `That isn't a valid mobile number in ${country}.`,
    };
  }
  return {
    ok: true,
    e164: result.phoneNumber,
    waId: result.phoneNumber.slice(1),
    country: result.countryIso2,
    international: formatInternational(result.countryCode, result.phoneNumber),
  };
}

/** `+234` and `+2348031234567` → `+234 803 123 4567`. */
function formatInternational(countryCode: string, e164: string): string {
  const national = e164.slice(countryCode.length);
  const groups =
    national.length > 7
      ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)]
      : [national];
  return `${countryCode} ${groups.join(" ")}`;
}

/** Whether a WhatsApp id (E.164 digits, no `+`) is a valid mobile number. */
export function isValidWaId(waId: string): boolean {
  return /^\d{7,15}$/.test(waId) && checkMobile(`+${waId}`).ok;
}

/** Every country the `phone` package knows, by name, Nigeria first. */
export function countryOptions(): CountryOption[] {
  const all = countryPhoneData.map((c) => ({
    code: c.alpha2,
    callingCode: c.country_code,
    name: c.country_name,
  }));
  all.sort((a, b) =>
    a.code === "NG" ? -1 : b.code === "NG" ? 1 : a.name.localeCompare(b.name),
  );
  return all;
}
