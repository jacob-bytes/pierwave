/**
 * ISO 3166-1 alpha-2 国家/地区代码白名单（官方分配的 249 个代码）。
 *
 * 只用于公开探针页的国旗：不查 GeoIP、不联网。后端也有一份同样的白名单，
 * 前端这里再判一次是为了兜住历史数据里可能已经存在的非法值。
 */
export const ISO_COUNTRY_CODES: readonly string[] = [
  "AD",
  "AE",
  "AF",
  "AG",
  "AI",
  "AL",
  "AM",
  "AO",
  "AQ",
  "AR",
  "AS",
  "AT",
  "AU",
  "AW",
  "AX",
  "AZ",
  "BA",
  "BB",
  "BD",
  "BE",
  "BF",
  "BG",
  "BH",
  "BI",
  "BJ",
  "BL",
  "BM",
  "BN",
  "BO",
  "BQ",
  "BR",
  "BS",
  "BT",
  "BV",
  "BW",
  "BY",
  "BZ",
  "CA",
  "CC",
  "CD",
  "CF",
  "CG",
  "CH",
  "CI",
  "CK",
  "CL",
  "CM",
  "CN",
  "CO",
  "CR",
  "CU",
  "CV",
  "CW",
  "CX",
  "CY",
  "CZ",
  "DE",
  "DJ",
  "DK",
  "DM",
  "DO",
  "DZ",
  "EC",
  "EE",
  "EG",
  "EH",
  "ER",
  "ES",
  "ET",
  "FI",
  "FJ",
  "FK",
  "FM",
  "FO",
  "FR",
  "GA",
  "GB",
  "GD",
  "GE",
  "GF",
  "GG",
  "GH",
  "GI",
  "GL",
  "GM",
  "GN",
  "GP",
  "GQ",
  "GR",
  "GS",
  "GT",
  "GU",
  "GW",
  "GY",
  "HK",
  "HM",
  "HN",
  "HR",
  "HT",
  "HU",
  "ID",
  "IE",
  "IL",
  "IM",
  "IN",
  "IO",
  "IQ",
  "IR",
  "IS",
  "IT",
  "JE",
  "JM",
  "JO",
  "JP",
  "KE",
  "KG",
  "KH",
  "KI",
  "KM",
  "KN",
  "KP",
  "KR",
  "KW",
  "KY",
  "KZ",
  "LA",
  "LB",
  "LC",
  "LI",
  "LK",
  "LR",
  "LS",
  "LT",
  "LU",
  "LV",
  "LY",
  "MA",
  "MC",
  "MD",
  "ME",
  "MF",
  "MG",
  "MH",
  "MK",
  "ML",
  "MM",
  "MN",
  "MO",
  "MP",
  "MQ",
  "MR",
  "MS",
  "MT",
  "MU",
  "MV",
  "MW",
  "MX",
  "MY",
  "MZ",
  "NA",
  "NC",
  "NE",
  "NF",
  "NG",
  "NI",
  "NL",
  "NO",
  "NP",
  "NR",
  "NU",
  "NZ",
  "OM",
  "PA",
  "PE",
  "PF",
  "PG",
  "PH",
  "PK",
  "PL",
  "PM",
  "PN",
  "PR",
  "PS",
  "PT",
  "PW",
  "PY",
  "QA",
  "RE",
  "RO",
  "RS",
  "RU",
  "RW",
  "SA",
  "SB",
  "SC",
  "SD",
  "SE",
  "SG",
  "SH",
  "SI",
  "SJ",
  "SK",
  "SL",
  "SM",
  "SN",
  "SO",
  "SR",
  "SS",
  "ST",
  "SV",
  "SX",
  "SY",
  "SZ",
  "TC",
  "TD",
  "TF",
  "TG",
  "TH",
  "TJ",
  "TK",
  "TL",
  "TM",
  "TN",
  "TO",
  "TR",
  "TT",
  "TV",
  "TW",
  "TZ",
  "UA",
  "UG",
  "UM",
  "US",
  "UY",
  "UZ",
  "VA",
  "VC",
  "VE",
  "VG",
  "VI",
  "VN",
  "VU",
  "WF",
  "WS",
  "YE",
  "YT",
  "ZA",
  "ZM",
  "ZW",
];

const ISO_COUNTRY_CODE_SET = new Set(ISO_COUNTRY_CODES);

/** 两位代码是否在官方白名单内；大小写不敏感，前后空白忽略。 */
export function isCountryCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const normalized = code.trim().toUpperCase();
  return ISO_COUNTRY_CODE_SET.has(normalized);
}

/** 归一成两位大写代码；空值或不在白名单返回 null。 */
export function normalizeCountryCode(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  return ISO_COUNTRY_CODE_SET.has(normalized) ? normalized : null;
}

/**
 * 两位国家/地区代码 → 国旗 emoji。
 *
 * 两个字母各自映射到区域指示符（U+1F1E6..U+1F1FF），拼起来就是系统字体
 * 渲染的国旗。空值、格式不对或不在白名单都返回 null，由组件改渲染地球图标
 * —— 不猜测，也不让标题行长度参差。
 */
export function countryCodeToFlag(
  code: string | null | undefined,
): string | null {
  const normalized = normalizeCountryCode(code);
  if (!normalized) return null;
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + normalized.charCodeAt(0) - 65,
    base + normalized.charCodeAt(1) - 65,
  );
}

/**
 * 国家/地区的本地化名称（`Intl.DisplayNames`），失败时回落到代码本身。
 * 调用方负责只在代码合法时调用；这里再判一次，避免把 `ZZ` 读成国家名。
 */
export function countryDisplayName(
  code: string,
  locale: string,
): string | null {
  const normalized = normalizeCountryCode(code);
  if (!normalized) return null;
  try {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    return names.of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

/**
 * 国家代码速查页：直接给 ISO 3166-1 的清单，按界面语言选维基条目。
 * 用户不知道 CN / JP 这类代码时点这个链接，不用在表单里写一段解释。
 */
export function countryLookupUrl(locale: string): string {
  const lang = locale.toLowerCase().startsWith("en") ? "en" : "zh";
  return lang === "en"
    ? "https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2"
    : "https://zh.wikipedia.org/wiki/ISO_3166-1%E4%BA%8C%E4%BD%8D%E5%AD%97%E6%AF%8D%E4%BB%A3%E7%A0%81";
}
