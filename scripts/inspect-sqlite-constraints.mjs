import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/muleshield.sqlite');

const objects = db.prepare(`
  SELECT type, name, tbl_name, sql
  FROM sqlite_master
  WHERE type IN ('table', 'index')
    AND name NOT LIKE 'sqlite_%'
  ORDER BY tbl_name, type, name
`).all();

for (const obj of objects) {
  console.log(`\n--- ${obj.type}: ${obj.name} (${obj.tbl_name}) ---`);
  console.log(obj.sql ?? '(No SQL definition)');
}

db.close();
