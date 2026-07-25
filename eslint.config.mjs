import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "artifacts/**",
      "coverage/**",
      "packages/**/dist/**",
      "packages/**/dist-executable/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
