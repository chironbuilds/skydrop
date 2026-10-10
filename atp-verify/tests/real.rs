use atp_verify::*;
use serde_json::Value;

fn load(name: &str) -> Value {
    let p = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn hexes(v: &Value) -> Vec<Vec<u8>> {
    v.as_array().unwrap().iter().map(|x| hex::decode(x.as_str().unwrap()).unwrap()).collect()
}

struct Fx {
    did: String,
    collection: String,
    rkey: String,
    ops: Vec<Vec<u8>>,
    commit: Vec<u8>,
    nodes: Vec<Vec<u8>>,
    record: Vec<u8>,
    text: String,
}

fn fx(name: &str) -> Fx {
    let v = load(name);
    Fx {
        did: v["did"].as_str().unwrap().into(),
        collection: v["collection"].as_str().unwrap().into(),
        rkey: v["rkey"].as_str().unwrap().into(),
        ops: hexes(&v["plcOps"]),
        commit: hex::decode(v["commit"].as_str().unwrap()).unwrap(),
        nodes: hexes(&v["mstNodes"]),
        record: hex::decode(v["record"].as_str().unwrap()).unwrap(),
        text: v["text"].as_str().unwrap().into(),
    }
}

fn run(f: &Fx) -> Result<(), Error> {
    let ops: Vec<&[u8]> = f.ops.iter().map(|o| o.as_slice()).collect();
    let chain = verify_plc_chain(&f.did, &ops)?;
    let nodes: Vec<&[u8]> = f.nodes.iter().map(|n| n.as_slice()).collect();
    verify_record(&f.did, &chain.signing_key, &f.commit, &nodes, &f.record, &f.collection, &f.rkey)?;
    assert_eq!(record_text(&f.record)?, f.text);
    Ok(())
}

#[test]
fn real_accounts_verify() {
    for name in ["bsky_app", "jay_bsky_team", "pfrazee_com"] {
        let f = fx(name);
        let ops: Vec<&[u8]> = f.ops.iter().map(|o| o.as_slice()).collect();
        let chain = verify_plc_chain(&f.did, &ops).unwrap_or_else(|e| panic!("{name}: chain {e:?}"));
        println!("{name}: {} ops, signing key {:?}", chain.len, chain.signing_key.alg);
        run(&f).unwrap_or_else(|e| panic!("{name}: record {e:?}"));
    }
}

#[test]
fn rejects_tampering() {
    let good = fx("pfrazee_com");
    assert!(run(&good).is_ok());

    // Wrong DID.
    let mut f = fx("pfrazee_com");
    f.did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa".into();
    assert_eq!(run(&f), Err(Error::BadDid));

    // A chain with an op dropped from the middle.
    let mut f = fx("pfrazee_com");
    f.ops.remove(2);
    assert!(matches!(run(&f), Err(Error::BrokenChain) | Err(Error::BadSignature)));

    // An op with a flipped byte.
    let mut f = fx("pfrazee_com");
    let n = f.ops[1].len();
    f.ops[1][n / 2] ^= 1;
    assert!(run(&f).is_err());

    // Commit tampered.
    let mut f = fx("pfrazee_com");
    let n = f.commit.len();
    f.commit[n / 3] ^= 1;
    assert!(run(&f).is_err());

    // Record swapped for different bytes.
    let mut f = fx("pfrazee_com");
    let n = f.record.len();
    f.record[n - 2] ^= 1;
    assert!(run(&f).is_err());

    // Wrong rkey.
    let mut f = fx("pfrazee_com");
    f.rkey = "3aaaaaaaaaaaa".into();
    assert!(run(&f).is_err());

    // Missing tree nodes.
    let mut f = fx("pfrazee_com");
    f.nodes.pop();
    assert!(run(&f).is_err());

    // A commit from one account cannot be used under another account's DID and key.
    let a = fx("pfrazee_com");
    let b = fx("jay_bsky_team");
    let ops: Vec<&[u8]> = b.ops.iter().map(|o| o.as_slice()).collect();
    let chain = verify_plc_chain(&b.did, &ops).unwrap();
    let nodes: Vec<&[u8]> = a.nodes.iter().map(|n| n.as_slice()).collect();
    assert!(verify_record(&b.did, &chain.signing_key, &a.commit, &nodes, &a.record, &a.collection, &a.rkey).is_err());
}
