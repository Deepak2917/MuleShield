import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/muleshield.sqlite');

const tables = db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all();

for (const table of tables) {
  console.log(`\n========== ${table.name} ==========`);
  console.table(
    db.prepare(`PRAGMA table_info("${table.name}")`).all()
  );
  console.log('Foreign keys:');
  console.table(
    db.prepare(`PRAGMA foreign_key_list("${table.name}")`).all()
  );
}

db.close();
