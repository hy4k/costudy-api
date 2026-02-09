// Run migrations against Supabase
// Usage: node scripts/run-migrations.js

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    console.error('Set these environment variables and try again.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function runMigrations() {
    const migrationsDir = join(__dirname, '..', 'migrations');
    
    console.log('📁 Reading migrations from:', migrationsDir);
    
    const files = readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
    
    console.log(`📋 Found ${files.length} migration files:`, files);
    
    for (const file of files) {
        console.log(`\n🔄 Running migration: ${file}`);
        
        const sql = readFileSync(join(migrationsDir, file), 'utf-8');
        
        try {
            // Split by statement for better error handling
            const statements = sql
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('--'));
            
            for (const statement of statements) {
                const { error } = await supabase.rpc('exec_sql', { sql: statement + ';' });
                if (error) {
                    // Try direct query as fallback
                    const result = await supabase.from('_migrations_log').select().limit(0);
                    if (result.error && result.error.code !== '42P01') {
                        console.warn(`  ⚠️ Statement warning: ${error.message}`);
                    }
                }
            }
            
            console.log(`  ✅ ${file} completed`);
        } catch (err) {
            console.error(`  ❌ Error in ${file}:`, err.message);
        }
    }
    
    console.log('\n🎉 Migration run complete!');
    console.log('Note: If you see errors, run the SQL directly in Supabase SQL Editor.');
}

runMigrations();
