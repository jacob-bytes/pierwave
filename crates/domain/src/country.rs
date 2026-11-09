//! ISO 3166-1 alpha-2 国家/地区代码白名单（官方分配的 249 个代码）。
//!
//! 为什么内置：`country_code` 只用于公开探针页的国旗，不做 GeoIP、不联网。
//! 校验只接受这份表里的两位大写字母；空值允许（表示未设置）。
//! `ZZ`、`XK` 等用户分配 / 非官方代码不在表内，避免显示一个「猜的国家」。

/// 官方分配的 ISO 3166-1 alpha-2 代码，全部大写、两位。
pub const ISO_ALPHA2_CODES: &[&str] = &[
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
    "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
    "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
    "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
    "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
    "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
    "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
    "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
    "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
    "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
    "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
    "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
    "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
    "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
    "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
    "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

/// 代码是否在官方白名单内。调用方负责先 trim；大小写必须完全一致。
pub fn is_valid_country_code(code: &str) -> bool {
    ISO_ALPHA2_CODES.contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_has_the_official_count_and_shape() {
        assert_eq!(ISO_ALPHA2_CODES.len(), 249);
        assert!(ISO_ALPHA2_CODES
            .iter()
            .all(|code| code.len() == 2 && code.chars().all(|ch| ch.is_ascii_uppercase())));
    }

    #[test]
    fn accepts_common_codes_and_rejects_user_assigned_ones() {
        for code in ["CN", "US", "JP", "DE", "GB", "HK", "TW"] {
            assert!(is_valid_country_code(code), "{code} 应通过");
        }
        for code in ["ZZ", "XK", "cn", "CHN", "", " C"] {
            assert!(!is_valid_country_code(code), "{code} 不应通过");
        }
    }
}
