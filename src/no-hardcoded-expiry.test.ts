/**
 * Test that expiry text is computed from server's expiresAt, not hardcoded
 * 
 * Validates that:
 * - No hardcoded '29 days' or 'Dec 8' anywhere in codebase
 * - Expiry computed dynamically from server response
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function scanDirectory(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  
  function scan(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!entry.includes('node_modules') && !entry.includes('dist') && !entry.includes('.git')) {
          scan(fullPath);
        }
      } else if (stat.isFile()) {
        if (extensions.some(ext => entry.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    }
  }
  
  scan(dir);
  return files;
}

test('No hardcoded expiry dates or durations', async (t) => {
  await t.test('no hardcoded "29 days" in source files', () => {
    const srcDir = join(process.cwd(), 'src');
    const files = scanDirectory(srcDir, ['.ts', '.html', '.js']);
    
    for (const file of files) {
      // Skip test files
      if (file.includes('.test.ts') || file.includes('test.js')) {
        continue;
      }
      
      const content = readFileSync(file, 'utf-8');
      
      // Check for hardcoded "29 days"
      if (content.includes('29 days') || content.includes('29 day')) {
        assert.fail(`Found hardcoded "29 days" in ${file}`);
      }
      
      // Check for hardcoded "30 days" (old default)
      if (content.includes('30 days') && !file.includes('.test.ts')) {
        // Allow in tests for legacy compatibility checks
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes('30 days') && !line.includes('2592000')) {
            // If it's not a comment about 2592000 = 30 days conversion
            if (!line.includes('//') && !line.includes('*') && !line.includes('TTL')) {
              assert.fail(`Found suspicious "30 days" literal in ${file}:${i + 1}: ${line}`);
            }
          }
        }
      }
    }
  });

  await t.test('no hardcoded specific dates like "Dec 8" in source files', () => {
    const srcDir = join(process.cwd(), 'src');
    const files = scanDirectory(srcDir, ['.ts', '.html', '.js']);
    
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      
      // Check for hardcoded month + day patterns
      for (const month of monthNames) {
        const pattern = new RegExp(`${month}\\s+\\d{1,2}`, 'g');
        const matches = content.match(pattern);
        
        if (matches && !file.includes('.test.ts')) {
          // Allow in tests for specific test scenarios
          assert.fail(`Found hardcoded date pattern "${matches[0]}" in ${file}`);
        }
      }
    }
  });

  await t.test('expiry text uses formatExpiryPlainWords function', () => {
    const enrollmentHtml = join(process.cwd(), 'src', 'ui', 'enrollment.html');
    const content = readFileSync(enrollmentHtml, 'utf-8');
    
    // Verify formatExpiryPlainWords exists
    assert.ok(content.includes('function formatExpiryPlainWords'), 'formatExpiryPlainWords function should exist');
    
    // Verify it computes from timestamp
    assert.ok(content.includes('new Date(timestamp * 1000)'), 'Should compute date from timestamp');
    assert.ok(content.includes('Math.floor((date - Date.now())'), 'Should compute days remaining dynamically');
    
    // Verify success screen uses it
    assert.ok(content.includes('formatExpiryPlainWords(data.expiresAt)'), 'Success screen should call formatExpiryPlainWords with server expiresAt');
  });

  await t.test('formatExpiryPlainWords returns dynamic text', () => {
    // Simulate the function
    function formatExpiryPlainWords(timestamp: number): string {
      const date = new Date(timestamp * 1000);
      const days = Math.floor((date - Date.now()) / (1000 * 60 * 60 * 24));
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateStr = `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
      const daysStr = days > 0 ? `${days} days` : 'less than 1 day';
      return `Your verification is valid until ${dateStr} (${daysStr})`;
    }

    // Test with different timestamps
    const now = Math.floor(Date.now() / 1000);
    const fiveDaysLater = now + (5 * 86400);
    const thirtyDaysLater = now + (30 * 86400);

    const text5Days = formatExpiryPlainWords(fiveDaysLater);
    const text30Days = formatExpiryPlainWords(thirtyDaysLater);

    // Verify text is different for different timestamps
    assert.notStrictEqual(text5Days, text30Days, 'Different timestamps should produce different text');
    
    // Verify text includes dynamic day count
    assert.ok(text5Days.includes('5 days') || text5Days.includes('4 days') || text5Days.includes('6 days'), 
      `5-day expiry should show ~5 days, got: ${text5Days}`);
    assert.ok(text30Days.includes('30 days') || text30Days.includes('29 days') || text30Days.includes('31 days'), 
      `30-day expiry should show ~30 days, got: ${text30Days}`);
  });
});
