#!/usr/bin/env node
/**
 * Launcher for openclaw-worldid-gate private service
 * 
 * This launcher validates environment configuration and starts the gate service.
 * It enforces configuration invariants to prevent misconfiguration.
 * 
 * Run: node bin/launch-private-service.cjs
 */

const { spawn } = require('node:child_process');
const { resolve } = require('node:path');

/**
 * Validate required environment variables and invariants
 */
function validateEnvironment() {
  const errors = [];
  
  // Required: OPENCLAW_ALLOWED_GROUP (values are never echoed: they are Telegram ids)
  const isNegativeInt = (v) => /^-[1-9][0-9]*$/.test(v);
  const allowedGroup = (process.env.OPENCLAW_ALLOWED_GROUP || '').trim();
  if (!allowedGroup) {
    errors.push('OPENCLAW_ALLOWED_GROUP is required');
  } else if (!isNegativeInt(allowedGroup)) {
    errors.push('OPENCLAW_ALLOWED_GROUP must be a negative integer');
  }

  // Optional: MEMBER_TAG_GROUPS (strict: no empty entries, no duplicates)
  const memberTagGroups = process.env.MEMBER_TAG_GROUPS;
  if (memberTagGroups !== undefined) {
    const entries = memberTagGroups.split(',').map(s => s.trim());
    const seen = new Set();
    entries.forEach((entry, i) => {
      if (!entry) {
        errors.push(`MEMBER_TAG_GROUPS entry ${i + 1} is empty`);
      } else if (!isNegativeInt(entry)) {
        errors.push(`MEMBER_TAG_GROUPS entry ${i + 1} must be a negative integer`);
      } else if (seen.has(entry)) {
        errors.push(`MEMBER_TAG_GROUPS entry ${i + 1} is a duplicate`);
      } else {
        seen.add(entry);
      }
    });

    // Invariant: MEMBER_TAG_GROUPS must include OPENCLAW_ALLOWED_GROUP
    if (allowedGroup && !seen.has(allowedGroup)) {
      errors.push('MEMBER_TAG_GROUPS must include OPENCLAW_ALLOWED_GROUP');
    }
  }
  
  if (errors.length > 0) {
    console.error('Environment validation failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  
  console.log('Environment validation passed');
}

/**
 * Start the service
 */
function startService() {
  const servicePath = resolve(__dirname, '../dist/server.js');
  
  console.log('Starting openclaw-worldid-gate service...');
  console.log(`Service: ${servicePath}`);
  
  const child = spawn('node', [servicePath], {
    stdio: 'inherit',
    env: process.env,
  });
  
  child.on('error', (error) => {
    console.error('Failed to start service:', error);
    process.exit(1);
  });
  
  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`Service terminated by signal: ${signal}`);
    } else if (code !== 0) {
      console.error(`Service exited with code: ${code}`);
      process.exit(code);
    }
  });
  
  // Forward signals
  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });
  
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}

// Main
validateEnvironment();
startService();
