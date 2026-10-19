import { writeFileSync } from "node:fs";

if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));
setTimeout(() => {}, Number(process.argv[2] ?? 30) * 1000);
