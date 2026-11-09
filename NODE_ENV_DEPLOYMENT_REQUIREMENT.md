# NODE_ENV Production Deployment Requirement

## Critical Configuration Requirement

The `directEnroll` method includes a `NODE_ENV === 'production'` guard to prevent test-only functionality from being available in production environments.

**HOWEVER:** The protected launcher configuration does NOT automatically set `NODE_ENV=production`.

## Deployment Requirement

Production deployments MUST explicitly set `NODE_ENV=production` before importing the enrollment service module.

### Correct Production Launcher

```javascript
// launcher.js or server.js
'use strict';

// SET THIS BEFORE ANY IMPORTS
process.env.NODE_ENV = 'production';

const { EnrollmentService } = require('./dist/enrollment-service-production.js');
const { WorldIdChallengeAdapter } = require('./dist/worldid-challenge-adapter.js');
// ... other imports ...

// Now initialize service
const service = new EnrollmentService({
  dbPath: process.env.DB_PATH || './enrollment.db',
  // ... other config ...
});
```

### What Happens Without NODE_ENV

If `NODE_ENV` is undefined or set to any value other than `'production'`:
- `directEnroll` method remains callable
- Bypasses authentication and challenge validation
- Bypasses World ID verification
- Direct database mutation possible

**This is a security risk in production.**

### Verification

Check your deployment:

```bash
# In your launcher or main entry point
node -e "console.log('NODE_ENV:', process.env.NODE_ENV)"
# Should output: NODE_ENV: production

# Test that directEnroll is blocked
node -e "
process.env.NODE_ENV = 'production';
const { EnrollmentService } = require('./dist/enrollment-service-production.js');
// Try to call directEnroll - should throw
"
```

### Alternative: Remove directEnroll from Production Build

If setting NODE_ENV in the launcher is not feasible, consider:

1. **Exclude from build**: Remove `directEnroll` method entirely from production compilation
2. **Conditional export**: Only export `directEnroll` in test builds
3. **Build-time guards**: Use build tool to strip test-only code

Current implementation relies on runtime `NODE_ENV` check only.

## Protected Launcher Compatibility

The existing protected JSON launcher configuration:
```json
{
  "service": "enrollment",
  "config": {
    "dbPath": "./enrollment.db",
    ...
  }
}
```

This configuration does NOT set environment variables.

**Action required:** Update launcher script to set `NODE_ENV=production` before loading configuration.

## Production Checklist

Before deploying to production:

- [ ] Launcher sets `process.env.NODE_ENV = 'production'` before imports
- [ ] Verify with `console.log(process.env.NODE_ENV)` on startup
- [ ] Test that `directEnroll` throws error in production
- [ ] Document in deployment runbook
- [ ] Add to CI/CD deployment scripts

## Test vs Production Environments

**Test/Development:**
- `NODE_ENV` undefined, `'test'`, `'development'`, etc.
- `directEnroll` available for test fixtures
- Used by test suite

**Production:**
- `NODE_ENV` MUST be `'production'`
- `directEnroll` blocked with error
- Only `completeEnrollment` available (with full authentication)

## Summary

**CRITICAL:** Set `process.env.NODE_ENV = 'production'` in your production launcher before importing enrollment service modules.

Without this, test-only backdoor methods remain accessible in production.
