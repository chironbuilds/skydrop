import { IndexerProvider } from "@tari-project/ootle-indexer";
import { Network, defaultIndexerUrl } from "@tari-project/ootle";
const p = await IndexerProvider.connect({ url: defaultIndexerUrl(Network.Esmeralda), network: Network.Esmeralda });
const c = await p.getSubstate("component_6aa79eaa110cc5b7b1fc672b3ad74d026259f6257884c565ed8d4ea529d69ec9");
const st = (c.substate as any).Component.body.state;
console.log("state len", st.length, JSON.stringify(st[6]), JSON.stringify(st[7]));
const vid = "vault_" + st[6].value.hex;
const v = await p.getSubstate(vid);
console.log(JSON.stringify(v).slice(0, 500));
