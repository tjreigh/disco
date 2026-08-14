import { bootstrapDb } from './bootstrap.js';

const { db } = bootstrapDb();
db.close();
