/** An ISO 3166 alpha-2 country code, e.g. `NG`. */
export type CountryCode = string;

export type PhoneCheck =
  | {
      ok: true;
      /** E.164, e.g. `+2348031234567`. */
      e164: string;
      /** The WhatsApp id: E.164 without the `+`. */
      waId: string;
      country: CountryCode;
      /** For display, e.g. `+234 803 123 4567`. */
      international: string;
    }
  | { ok: false; error: string };

export interface CountryOption {
  code: CountryCode;
  callingCode: string;
  name: string;
}
