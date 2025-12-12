process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-123456";
process.env.JWT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN ?? "15m";
process.env.JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN ?? "7d";

process.env.MYSQL_HOST = process.env.MYSQL_HOST ?? "localhost";
process.env.MYSQL_PORT = process.env.MYSQL_PORT ?? "3306";
process.env.MYSQL_USER = process.env.MYSQL_USER ?? "root";
process.env.MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? "secret";
process.env.MYSQL_DB = process.env.MYSQL_DB ?? "app";

process.env.MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017";
process.env.REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
process.env.REDIS_PORT = process.env.REDIS_PORT ?? "6379";

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "test-nextauth-123456";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
process.env.API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000";
process.env.GRAPHQL_PLAYGROUND = process.env.GRAPHQL_PLAYGROUND ?? "true";
process.env.GRAPHQL_INTROSPECTION = process.env.GRAPHQL_INTROSPECTION ?? "true";

process.env.SMTP_USER = process.env.SMTP_USER ?? "test@example.com";
process.env.SMTP_PASS = process.env.SMTP_PASS ?? "test";
process.env.CRAWL4AI_BASE_URL = process.env.CRAWL4AI_BASE_URL ?? "http://localhost:8082";
