# Quick Start: Testing JWT Refresh Token Implementation

This guide helps you quickly test the new JWT refresh token implementation.

## Prerequisites

- Node.js installed
- PostgreSQL running
- Database created

## Setup (5 minutes)

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/nebgov
JWT_SECRET=your-secret-key-here
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

### 3. Run Migration

```bash
npm run migrate
```

You should see: `✅ Migrations completed successfully`

### 4. Start Server

```bash
npm run dev
```

Server should start on port 3001.

## Manual Testing (5 minutes)

### Test 1: Login

```bash
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"wallet_address":"GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}' \
  -c cookies.txt \
  -v
```

**Expected:**

- Status: 200
- Response contains `accessToken`, `user_id`, `wallet_address`
- Cookie `refreshToken` is set (check verbose output)

**Save the access token** from the response for next tests.

### Test 2: Use Access Token

```bash
# Replace YOUR_ACCESS_TOKEN with the token from Test 1
curl -X GET http://localhost:3001/leaderboard \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected:**

- Status: 200 (or 404 if no leaderboard data)
- Request is authenticated

### Test 3: Refresh Token

```bash
curl -X POST http://localhost:3001/auth/refresh \
  -b cookies.txt \
  -c cookies.txt \
  -v
```

**Expected:**

- Status: 200
- Response contains new `accessToken`
- New `refreshToken` cookie is set
- Old refresh token is invalidated

### Test 4: Try Old Refresh Token (Should Fail)

```bash
# Save the old cookie first
cp cookies.txt cookies_old.txt

# Get new token
curl -X POST http://localhost:3001/auth/refresh \
  -b cookies.txt \
  -c cookies.txt

# Try to use old cookie (should fail)
curl -X POST http://localhost:3001/auth/refresh \
  -b cookies_old.txt
```

**Expected:**

- Status: 401
- Error: "Invalid refresh token"

### Test 5: Logout

```bash
curl -X POST http://localhost:3001/auth/logout \
  -b cookies.txt \
  -v
```

**Expected:**

- Status: 200
- Message: "Logged out successfully"
- Cookie is cleared

### Test 6: Try Refresh After Logout (Should Fail)

```bash
curl -X POST http://localhost:3001/auth/refresh \
  -b cookies.txt
```

**Expected:**

- Status: 401
- Error: "Invalid refresh token"

## Automated Testing

Run the test suite:

```bash
npm test -- auth.test.ts
```

**Expected:**

- All 14 tests pass
- No errors

If tests fail with database connection errors, ensure:

1. PostgreSQL is running
2. `DATABASE_URL` is set correctly
3. Database exists and migrations have run

## Testing with Frontend

### 1. Start Backend

```bash
cd backend
npm run dev
```

### 2. Test Login from Browser Console

```javascript
// Login
const loginResponse = await fetch("http://localhost:3001/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    wallet_address: "GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  }),
});

const { accessToken, user_id } = await loginResponse.json();
console.log("Access Token:", accessToken);
console.log("User ID:", user_id);

// Check cookie was set
console.log("Cookies:", document.cookie);
// Note: You won't see refreshToken because it's httpOnly
```

### 3. Test Refresh

```javascript
// Refresh token
const refreshResponse = await fetch("http://localhost:3001/auth/refresh", {
  method: "POST",
  credentials: "include",
});

const { accessToken: newToken } = await refreshResponse.json();
console.log("New Access Token:", newToken);
```

### 4. Test Logout

```javascript
// Logout
const logoutResponse = await fetch("http://localhost:3001/auth/logout", {
  method: "POST",
  credentials: "include",
});

const result = await logoutResponse.json();
console.log(result); // { message: "Logged out successfully" }
```

## Verify Database

Check that tokens are being stored:

```sql
-- Connect to database
psql postgresql://user:password@localhost:5432/nebgov

-- Check users
SELECT * FROM users;

-- Check refresh tokens
SELECT id, user_id, expires_at, created_at FROM refresh_tokens;

-- Check token expiry (should be 7 days from created_at)
SELECT
  id,
  user_id,
  expires_at - created_at as lifetime,
  expires_at > NOW() as is_valid
FROM refresh_tokens;
```

## Common Issues

### Issue: "Cannot connect to database"

**Solution:**

- Check PostgreSQL is running: `pg_isready`
- Verify DATABASE_URL in `.env`
- Test connection: `psql $DATABASE_URL`

### Issue: "relation 'refresh_tokens' does not exist"

**Solution:**

- Run migration: `npm run migrate`
- Or manually apply SQL from `migrations/` (see `backend/README.md`)

### Issue: "Refresh token required"

**Solution:**

- Ensure you're using `-b cookies.txt` to send cookies
- Check cookie was set in login response (use `-v` flag)
- Verify `credentials: 'include'` in fetch calls

### Issue: Tests fail with "AggregateError"

**Solution:**

- Database connection issue
- Set DATABASE_URL environment variable
- Ensure test database exists and is accessible

### Issue: "CORS error" in browser

**Solution:**

- Set `FRONTEND_URL` in `.env`
- Ensure frontend URL matches exactly
- Check CORS configuration in `src/index.ts`

## Success Criteria

You've successfully tested the implementation if:

- ✅ Login returns access token and sets cookie
- ✅ Refresh returns new access token
- ✅ Old refresh tokens can't be reused
- ✅ Logout invalidates tokens
- ✅ All automated tests pass
- ✅ Tokens are stored in database

## Next Steps

1. Review `AUTH_IMPLEMENTATION.md` for detailed documentation
2. Review `MIGRATION_GUIDE.md` for frontend integration
3. Integrate with your frontend application
4. Deploy to staging environment
5. Test in production-like environment

## Need Help?

- Check `AUTH_IMPLEMENTATION.md` for detailed docs
- Check `MIGRATION_GUIDE.md` for troubleshooting
- Review test file `src/__tests__/auth.test.ts` for examples
- Check server logs for error messages
