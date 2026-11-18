// ESLint checks both Minecraft scripts and the Node.js development tools.
export default [
    {
        ignores: ["builds/**", "node_modules/**", "addon/rp/**"],
    },
    {
        files: ["addon/bp/scripts/**/*.js", "tools/**/*.mjs", "eslint.config.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                console: "readonly",
                process: "readonly",
                Buffer: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
            },
        },
        rules: {
            // Errors: clear mistakes that should stop a build.
            "constructor-super": "error",
            "for-direction": "error",
            "getter-return": "error",
            "no-async-promise-executor": "error",
            "no-compare-neg-zero": "error",
            "no-cond-assign": "error",
            "no-constant-binary-expression": "error",
            "no-const-assign": "error",
            "no-debugger": "error",
            "no-dupe-args": "error",
            "no-dupe-class-members": "error",
            "no-dupe-else-if": "error",
            "no-duplicate-case": "error",
            "no-empty-character-class": "error",
            "no-empty-pattern": "error",
            "no-ex-assign": "error",
            "no-extra-boolean-cast": "error",
            "no-func-assign": "error",
            "no-global-assign": "error",
            "no-import-assign": "error",
            "no-invalid-regexp": "error",
            "no-loss-of-precision": "error",
            "no-obj-calls": "error",
            "no-self-assign": "error",
            "no-sparse-arrays": "error",
            "no-undef": "error",
            "no-unexpected-multiline": "error",
            "no-unreachable": "error",
            "no-unsafe-finally": "error",
            "no-unsafe-negation": "error",
            "no-unsafe-optional-chaining": "error",
            "no-unused-labels": "error",
            "use-isnan": "error",
            "valid-typeof": "error",
            // Warnings: useful cleanup hints that won't block a release by themselves.
            eqeqeq: ["warn", "always", { null: "ignore" }],
            "no-constant-condition": ["warn", { checkLoops: false }],
            "no-empty": ["warn", { allowEmptyCatch: true }],
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
            "no-var": "warn",
            "prefer-const": "warn",
            // Existing patterns: keep deliberate behavior unchanged.
            "no-promise-executor-return": "off",
        },
    },
    {
        // These globals belong to Node.js tools, not to Minecraft's script runtime.
        files: ["tools/**/*.mjs"],
        languageOptions: {
            globals: {
                URL: "readonly",
                structuredClone: "readonly",
            },
        },
    },
];
