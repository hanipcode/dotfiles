return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"williamboman/mason.nvim",
		"mfussenegger/nvim-dap",
		"jay-babu/mason-nvim-dap.nvim",
		"WhoIsSethDaniel/mason-tool-installer.nvim",
		"williamboman/mason-lspconfig.nvim",
		"hrsh7th/cmp-nvim-lsp",
		"hrsh7th/cmp-buffer",
		"hrsh7th/cmp-path",
		"hrsh7th/cmp-cmdline",
		"hrsh7th/nvim-cmp",

		-- "L3MON4D3/LuaSnip",
		-- "saadparwaiz1/cmp_luasnip",
		-- "pmizio/typescript-tools.nvim",
		"yioneko/nvim-vtsls",
		"j-hui/fidget.nvim",
	},

	-- create new function for switch context
	config = function()
		local cmp = require("cmp")
		local cmp_lsp = require("cmp_nvim_lsp")
		local capabilities = vim.tbl_deep_extend(
			"force",
			{},
			vim.lsp.protocol.make_client_capabilities(),
			cmp_lsp.default_capabilities()
		)

		require("fidget").setup({
			notification = {
				window = {
					winblend = 0,
					blend = 0,
				},
			},
		})

		vim.lsp.config("ols", {
			capabilities = capabilities,
			init_options = {
				enable_inlay_hints_params = true,
				enable_inlay_hints_default_params = true,
				enable_inlay_hints_implicit_return = true,
				enable_inlay_hints_optional_result = true,
			},
		})

		-- base mason setup
		require("mason").setup()
		-- mason lspconfig
		require("mason-lspconfig").setup({
			ensure_installed = {
				"biome", -- Biome LSP for JS/TS
				"vtsls", -- TypeScript/JavaScript
				"lua_ls", -- Lua
				"pyright", -- Python
				"oxlint",
				"eslint",
				"ols", -- Odin (also installs odinfmt)
			},
			automatic_enable = {
				exclude = { "vtsls" },
			},
		})

		-- TypeScript 7 (tsgo) — the native Go language server, replaces vtsls.
		-- Uses nvim-lspconfig's bundled `tsgo` config (cmd: tsgo --lsp --stdio).
		-- Installed globally via: npm install -g @typescript/native-preview
		vim.lsp.config("tsgo", {
			capabilities = capabilities,
			settings = {
				typescript = {
					inlayHints = {
						parameterNames = { enabled = "all" },
						parameterTypes = { enabled = true },
						variableTypes = { enabled = true },
						propertyDeclarationTypes = { enabled = true },
						functionLikeReturnTypes = { enabled = true },
						enumMemberValues = { enabled = true },
					},
				},
			},
		})
		vim.lsp.enable("tsgo")

		-- vtsls fallback — re-enable this (and disable tsgo above) if tsgo misses something
		-- require("lspconfig.configs").vtsls = require("vtsls").lspconfig
		-- require("lspconfig").vtsls.setup({
		-- 	capabilities = capabilities,
		-- 	settings = {
		-- 		typescript = {
		-- 			tsserver = { useSyntaxServer = "auto", pluginPaths = { "./node_modules" } },
		-- 		},
		-- 		vtsls = {
		-- 			autoUseWorkspaceTsdk = true,
		-- 			experimental = { completion = { enableServerSideFuzzyMatch = true } },
		-- 		},
		-- 	},
		-- })

		-- mason tool installer

		local mason_tool_installer = require("mason-tool-installer")
		mason_tool_installer.setup({
			ensure_installed = {
				"biome", -- Biome formatter and linter
				"golangci-lint",
				"prettier", -- prettier formatter
				"prettierd",
				"stylua", -- lua formatter
				"isort", -- python formatter
				"black", -- python formatter
				"pylint",
				"eslint",
			},
		})

		-- mason dap
		require("mason-nvim-dap").setup({
			ensure_installed = {
				"codelldb",
				"sourcekit-lsp",
			},
		})
		-- SourceKit-LSP increasingly relies on the editor informing the server when certain files change.
		-- This need is communicated through dynamic registration. You don’t have to understand what that
		-- means, but Neovim doesn’t implement dynamic registration. You’ll notice this when you update
		-- your package manifest, or add new files to your compile_commands.json file and LSP doesn’t
		-- work without restarting Neovim.
		--
		-- Instead, we know that SourceKit-LSP needs this functionality, so we’ll enable it statically.
		-- We’ll update our sourcekit setup configuration to manually set the didChangeWatchedFiles
		-- capability.
		--

		-- Configure LSP servers

		local XCODE_DEV = "/Applications/Xcode.app/Contents/Developer"
		local XCODE_TC = XCODE_DEV .. "/Toolchains/XcodeDefault.xctoolchain"

		local cmp_caps = require("cmp_nvim_lsp").default_capabilities()

		vim.lsp.config("sourcekit", {
			cmd = { XCODE_TC .. "/usr/bin/sourcekit-lsp" }, -- Xcode toolchain override
			filetypes = { "swift" },
			single_file_support = true,
			offset_encoding = "utf-16",
			capabilities = vim.tbl_deep_extend("force", cmp_caps, {
				general = { positionEncodings = { "utf-16" } },
				workspace = { didChangeWatchedFiles = { dynamicRegistration = true } },
			}),
		})
		vim.lsp.enable("sourcekit")

		local cmp_select = { behavior = cmp.SelectBehavior.Select }

		cmp.setup({
			mapping = cmp.mapping.preset.insert({
				["<C-p>"] = cmp.mapping.select_prev_item(cmp_select),
				["<C-n>"] = cmp.mapping.select_next_item(cmp_select),
				["<CR>"] = cmp.mapping.confirm({ select = true }),
				["<C-space>"] = cmp.mapping.complete(),
				["<Tab>"] = cmp.mapping(function(fallback)
					if cmp.visible() then
						cmp.select_next_item()
					else
						fallback()
					end
				end, { "i", "s" }),
				["<S-Tab>"] = cmp.mapping(function(fallback)
					if cmp.visible() then
						cmp.select_prev_item()
					else
						fallback()
					end
				end, { "i", "s" }),
			}),

			-- cmp configs
			sources = cmp.config.sources({
				{
					name = "nvim_lsp",
					entry_filter = function(entry, ctx)
						return require("cmp").lsp.CompletionItemKind.Snippet ~= entry:get_kind()
					end,
				},
			}, { name = "path" }, {
				{ name = "buffer" },
			}),
		})

		-- `/` cmdline setup.
		cmp.setup.cmdline("/", {
			mapping = cmp.mapping.preset.cmdline(),
			sources = {
				{ name = "buffer" },
			},
		})

		cmp.setup.cmdline(":", {
			mapping = cmp.mapping.preset.cmdline(),
			sources = cmp.config.sources({
				{ name = "path" },
			}, {
				{
					name = "cmdline",
					option = {
						ignore_cmds = { "Man", "!" },
					},
				},
			}),
		})

		-- end of cmp

		vim.diagnostic.config({
			-- update_in_insert = true,
			float = {
				focusable = false,
				style = "minimal",
				border = "rounded",
				source = "always",
				header = "",
				prefix = "",
			},
		})

		vim.api.nvim_create_autocmd("LspAttach", {
			group = vim.api.nvim_create_augroup("UserLspConfig", {}),
			callback = function(ev)
				local opts = { buffer = ev.buf, silent = true, noremap = true }

				vim.keymap.set("n", "gD", vim.lsp.buf.declaration, opts)
				vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
				vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
				vim.keymap.set("n", "gi", vim.lsp.buf.implementation, opts)
				vim.keymap.set({ "n", "i" }, "<C-k>", vim.lsp.buf.signature_help, opts)
				vim.keymap.set({ "n", "i" }, "<C-t>", function()
					vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled({ 0 }), { 0 })
				end)
				vim.keymap.set("n", "gT", vim.lsp.buf.type_definition, opts)
				vim.keymap.set("n", "<space>rn", vim.lsp.buf.rename, opts)
				vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)
				vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, opts)
				vim.keymap.set("n", "]d", vim.diagnostic.goto_next, opts)
				vim.keymap.set("n", "<space>q", vim.diagnostic.setloclist, opts)

				-- LSPConfig Extended Mappings
				local keymap = vim.keymap
				-- local fzf = require("fzf-lua")
				local telescope_builtin = require("telescope.builtin")

				-- set keybinds
				keymap.set("n", "<leader>pr", function()
					-- fzf.lsp_references()
					telescope_builtin.lsp_references()
				end, opts) -- show definition, references

				-- gd already set above to use vim.lsp.buf.definition for direct jump
				keymap.set("n", "<leader>pd", function()
					-- fzf.lsp_definitions()
					telescope_builtin.lsp_definitions()
				end, opts) -- show lsp definitions

				keymap.set("n", "<leader>pi", function()
					-- fzf.lsp_implementations()
					telescope_builtin.lsp_implementations()
				end, opts) -- show lsp implementations
				keymap.set("n", "<leader>pt", function()
					-- fzf.lsp_typedefs()
					telescope_builtin.lsp_type_definitions()
				end, opts) -- show lsp type definitions
				-- keymap.set("n", "<leader>pw", function() fzf.lsp_workspace_symbols() end, opts) -- show lsp workspace symbols
				-- keymap.set("n", "<leader>pI", function() fzf.lsp_incoming_calls() end, opts) -- lsp incoming calls
				-- keymap.set("n", "<leader>pO", function() fzf.lsp_outgoing_calls() end, opts)
				-- keymap.set("n", "<leader>po", function() fzf.lsp_document_symbols() end, opts) -- show lsp document/buffer symbols

				keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, opts) -- see available code actions, in visual mode will apply to selection

				keymap.set("n", "<leader>D", function()
					telescope_builtin.diagnostics()
					-- fzf.diagnostics_document()
				end, opts) -- show  diagnostics for file

				keymap.set("n", "<leader>e", vim.diagnostic.open_float, opts) -- show diagnostics for line

				keymap.set("n", "<leader>rs", ":LspRestart<CR>", opts) -- mapping to restart lsp if necessary

				-- dap
				keymap.set("n", "<leader>db", "<cmd>DapToggleBreakpoint<CR>", { desc = "Breakpoint" })
				keymap.set("n", "<leader>dr", "<cmd>DapContinue<CR>", { desc = "Dap Continue" })
			end,
		})
	end,
}
