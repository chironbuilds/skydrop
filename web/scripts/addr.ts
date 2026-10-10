import { initStorage, openAccount } from "./shim";

initStorage();
const a = openAccount(process.env.E2E_SEED!);
console.log(await a.getWalletAddress());
