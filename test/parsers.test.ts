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
  test.each([
    ["1234", "11 digits"],
    ["223456789012", "11 digits"],
    ["2223334445a", "digits only"],
    ["", "11 digits"],
    ["12345678901", "starts with 22"],
    ["22222222222", "isn't a valid BVN"],
  ])("rejects %p", (input, why) => {
    const result = parseBvn(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(why);
  });
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
  test("rejects the future and under-5s, accepts a 5th birthday", () => {
    expect(parseDateOfBirth("01/01/2030", NOW).ok).toBe(false);
    expect(parseDateOfBirth("05/11/2021", NOW).ok).toBe(false);
    expect(parseDateOfBirth("04/11/2021", NOW).ok).toBe(true);
  });
  test("rejects anyone over 120", () => {
    expect(parseDateOfBirth("03/11/1905", NOW).ok).toBe(false);
    expect(parseDateOfBirth("04/11/1906", NOW).ok).toBe(true);
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
  test.each([
    "123",
    "12345",
    "abcd",
    "0000",
    "1234",
    "6789",
    "4321",
    "1212",
    "4848",
  ])("rejects %p", (pin) => {
    expect(parseNewPin(pin).ok).toBe(false);
  });
  test("rejects the birth year and the day and month", () => {
    for (const pin of ["1990", "2512", "1225"])
      expect(parseNewPin(pin, "1990-12-25").ok).toBe(false);
    expect(parseNewPin("4826", "1990-12-25").ok).toBe(true);
  });
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
