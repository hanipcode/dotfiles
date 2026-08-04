return {
	"imNel/monorepo.nvim",
	config = function()
		require("monorepo").setup({
			silent = false,
			autoload_telescope = true,
		})
		vim.keymap.set("n", "<leader>pm", function()
			require("telescope").extensions.monorepo.monorepo()
		end)
		vim.keymap.set("n", "<leader>mp", function()
			require("monorepo").toggle_project()
		end)

		vim.keymap.set("n", "<leader>ma", function()
			require("monorepo").go_to_project(1)
		end)

		vim.keymap.set("n", "<leader>ms", function()
			require("monorepo").go_to_project(2)
		end)

		vim.keymap.set("n", "<leader>md", function()
			require("monorepo").go_to_project(3)
		end)

		vim.keymap.set("n", "<leader>mf", function()
			require("monorepo").go_to_project(4)
		end)
	end,
	dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim" },
}
