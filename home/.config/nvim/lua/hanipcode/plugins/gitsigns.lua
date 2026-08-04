return {
	"lewis6991/gitsigns.nvim",
	event = { "BufReadPre", "BufNewFile", "BufReadPost", "BufWritePost" },
	config = function()
		require("gitsigns").setup({
			current_line_blame = true,
		})

		local gitsigns = require("gitsigns")

		local function map(mode, l, r, opts)
			opts = opts or {}
			opts.buffer = bufnr
			vim.keymap.set(mode, l, r, opts)
		end

		-- Navigation
		map("n", "<leader>]s", function()
			gitsigns.nav_hunk("next")
		end)

		map("n", "<leader>[s", function()
			gitsigns.nav_hunk("prev")
		end)
		--
		-- -- Actions
		-- -- map("n", "<leader>gs", gitsigns.stage_hunk)
		-- -- map("n", "<leader>gr", gitgns.reset_hunk)
		-- -- map("v", "<leader>gs", function()
		-- -- 	gitsigns.stage_hunk({ vim.fn.line("."), vim.fn.line("v") })
		-- -- end)
		-- -- map("v", "<leader>gr", function()
		-- -- 	gitsigns.reset_hunk({ vim.fn.line("."), vim.fn.line("v") })
		-- -- end)
		-- -- map("n", "<leader>ga", gitsigns.stage_buffer)
		-- -- map("n", "<leader>gua", gitsigns.undo_stage_buffer)
		-- -- map("n", "<leader>gus", gitsigns.undo_stage_hunk)
		-- map("n", "<leader>gR", gitsigns.reset_buffer)
		-- map("n", "<leader>gQ", function()
		-- 	gitsigns.setqflist("all")
		-- end)
		-- map("n", "<leader>gq", gitsigns.setqflist)
		-- -- map("n", "<leader>gp", gitsigns.preview_hunk)
		-- map("n", "<leader>gb", function()
		-- 	gitsigns.blame_line({ full = true })
		-- end)
		-- map("n", "<leader>gcb", gitsigns.toggle_current_line_blame)
		-- map("n", "<leader>gd", gitsigns.diffthis)
		-- map("n", "<leader>gD", function()
		-- 	gitsigns.diffthis("~")
		-- end)
		-- map("n", "<leader>gt", gitsigns.toggle_deleted)

		-- Text object
		-- map({ "o", "x" }, "gsh", ":<C-U>Gitsigns select_hunk<CR>")
	end,
}
