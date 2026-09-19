import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "file:./dev.db",
      DEPLOYMENT_MODE: "local"
    },
    exclude: [
      ...configDefaults.exclude,
      "scripts/**",
      "sites/**",
      ".build-home/**"
    ]
  }
});
