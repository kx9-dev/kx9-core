import fs from "node:fs";import pg from "pg";
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is required.");
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await p.query(fs.readFileSync(new URL("../schema.sql",import.meta.url),"utf8"));console.log("Schema initialized; no account data imported.");}finally{await p.end();}
