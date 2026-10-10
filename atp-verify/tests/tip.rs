use atp_verify::tip::parse_tip;

const BOT: &str = "did:plc:botbotbotbotbotbotbotbo";
const ALICE: &str = "did:plc:alicealicealicealiceali";

fn head(major: u8, n: u64, out: &mut Vec<u8>) {
    let m = major << 5;
    if n < 24 {
        out.push(m | n as u8);
    } else if n < 256 {
        out.extend([m | 24, n as u8]);
    } else {
        out.extend([m | 25, (n >> 8) as u8, n as u8]);
    }
}

fn txt(s: &str, out: &mut Vec<u8>) {
    head(3, s.len() as u64, out);
    out.extend(s.as_bytes());
}

fn facet(start: u64, end: u64, ty: &str, did: &str, out: &mut Vec<u8>) {
    head(5, 2, out);
    txt("index", out);
    head(5, 2, out);
    txt("byteEnd", out);
    head(0, end, out);
    txt("byteStart", out);
    head(0, start, out);
    txt("features", out);
    head(4, 1, out);
    head(5, 2, out);
    txt("did", out);
    txt(did, out);
    txt("$type", out);
    txt(ty, out);
}

fn record(text: &str, facets: &[(u64, u64, &str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    head(5, 3, &mut out);
    txt("text", &mut out);
    txt(text, &mut out);
    txt("facets", &mut out);
    head(4, facets.len() as u64, &mut out);
    for (s, e, ty, d) in facets {
        facet(*s, *e, ty, d, &mut out);
    }
    txt("$type", &mut out);
    txt("app.bsky.feed.post", &mut out);
    out
}

const M: &str = "app.bsky.richtext.facet#mention";

fn tip(text: &str, bot_end: u64, alice: (u64, u64)) -> Result<(String, u64), atp_verify::Error> {
    parse_tip(&record(text, &[(0, bot_end, M, BOT), (alice.0, alice.1, M, ALICE)]), BOT)
}

#[test]
fn valid_tips() {
    // "@taridrop.bsky.social" is 21 bytes, " tip " is 5, "@alice.bsky.social" is 18.
    let t = "@taridrop.bsky.social tip @alice.bsky.social 5";
    assert_eq!(tip(t, 21, (26, 44)).unwrap(), (ALICE.to_string(), 5_000_000));
    let t = "@taridrop.bsky.social tip @alice.bsky.social 0.25 tTARI";
    assert_eq!(tip(t, 21, (26, 44)).unwrap(), (ALICE.to_string(), 250_000));
}

#[test]
fn rejects_malformed() {
    let ok = "@taridrop.bsky.social tip @alice.bsky.social 5";
    // Wrong verb, missing amount, junk after the amount, zero, wrong bot, not at start.
    for t in [
        "@taridrop.bsky.social send @alice.bsky.social 5",
        "@taridrop.bsky.social tip @alice.bsky.social",
        "@taridrop.bsky.social tip @alice.bsky.social 5 please",
        "@taridrop.bsky.social tip @alice.bsky.social 0",
        "@taridrop.bsky.social tip @alice.bsky.social -5",
    ] {
        assert!(tip(t, 21, (26, 44)).is_err(), "{t}");
    }
    assert!(parse_tip(&record(ok, &[(0, 21, M, ALICE), (26, 44, M, ALICE)]), BOT).is_err());
    assert!(tip(&format!(" {ok}"), 22, (27, 45)).is_err());
    // A link facet where the mention should be.
    let r = record(ok, &[(0, 21, M, BOT), (26, 44, "app.bsky.richtext.facet#link", ALICE)]);
    assert!(parse_tip(&r, BOT).is_err());
    // Recipient must not be the bot itself.
    let r = record(ok, &[(0, 21, M, BOT), (26, 44, M, BOT)]);
    assert!(parse_tip(&r, BOT).is_err());
}
