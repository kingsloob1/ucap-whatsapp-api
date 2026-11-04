import { describe, expect, test } from "bun:test";
import {
  formatNaira,
  maskBvn,
  parseAmount,
  parseBvn,
  parseDateOfBirth,
  parseNewPin,
  parseSelection,
} from "../src/conversation/parsers";

const NOW = new Date("2026-11-04T12:00:00Z");

describe("parseBvn", () => {
  test("accepts 11 digits, ignoring spaces and dashes", () => {
    expect(parseBvn("222 333-444 55")).toEqual({
      ok: true,
      value: "22233344455",
    });
  });
  test.each(["1234", "123456789012", "2223334445a", ""])(
    "rejects %p",
    (input) => {
      expect(parseBvn(input).ok).toBe(false);
    },
  );
});

describe("parseDateOfBirth", () => {
  test.each([
    ["25/12/1990", "1990-12-25"],
    ["5-1-1990", "1990-01-05"],
    ["05.01.1990", "1990-01-05"],
    ["1990-12-25", "1990-12-25"],
  ])("reads %p", (input, iso) => {
    expect(parseDateOfBirth(input, NOW)).toEqual({ ok: true, value: iso });
  });
  test("rejects a date that doesn't exist", () => {
    expect(parseDateOfBirth("31/02/1990", NOW).ok).toBe(false);
  });
  test("rejects the future and under-18s, accepts an 18th birthday", () => {
    expect(parseDateOfBirth("01/01/2030", NOW).ok).toBe(false);
    expect(parseDateOfBirth("05/11/2008", NOW).ok).toBe(false);
    expect(parseDateOfBirth("04/11/2008", NOW).ok).toBe(true);
  });
  test("rejects other formats", () => {
    expect(parseDateOfBirth("December 25 1990", NOW).ok).toBe(false);
  });
});

describe("parseSelection", () => {
  test.each([
    ["1,3,4", [0, 2, 3]],
    ["4 1 3", [0, 2, 3]],
    ["1, 3 and 4", [0, 2, 3]],
    ["2 & 2", [1]],
    ["all", [0, 1, 2, 3, 4, 5]],
  ])("reads %p", (input, indexes) => {
    expect(parseSelection(input, 6)).toEqual({ ok: true, value: indexes });
  });
  test.each(["", "0", "7", "money market", "1,x"])("rejects %p", (input) => {
    expect(parseSelection(input, 6).ok).toBe(false);
  });
});

describe("parseNewPin", () => {
  test("accepts an ordinary PIN", () => {
    expect(parseNewPin(" 4826 ")).toEqual({ ok: true, value: "4826" });
  });
  test.each(["123", "12345", "abcd", "0000", "1234", "6789", "4321"])(
    "rejects %p",
    (pin) => {
      expect(parseNewPin(pin).ok).toBe(false);
    },
  );
});

describe("parseAmount", () => {
  test.each([
    ["5000", 500_000],
    ["5,000", 500_000],
    ["₦5,000.50", 500_050],
    ["N5000", 500_000],
    ["ngn 2500", 250_000],
    ["5k", 500_000],
    ["1.5m", 150_000_000],
  ])("reads %p", (input, kobo) => {
    expect(parseAmount(input)).toEqual({ ok: true, value: kobo });
  });
  test.each(["", "five", "50", "-100", "20000000", "5.123"])(
    "rejects %p",
    (input) => {
      expect(parseAmount(input).ok).toBe(false);
    },
  );
});

test("formatNaira and maskBvn", () => {
  expect(formatNaira(123_456_789)).toBe("₦1,234,567.89");
  expect(maskBvn("22233344455")).toBe("*******4455");
});
