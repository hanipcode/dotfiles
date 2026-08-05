return {
	"TobinPalmer/pastify.nvim",
	cmd = { "Pastify", "PastifyAfter" },
	init = function()
		vim.g.python3_host_prog = vim.fn.stdpath("data") .. "/pastify-python/bin/python"
	end,
	opts = {},
}
