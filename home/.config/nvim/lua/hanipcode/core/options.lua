vim.cmd("let g:netrw_liststyle = 3")
vim.g.netrw_banner = 0

-- Set leader key
vim.g.mapleader = " "

-- Set options
vim.o.ignorecase = true
vim.o.mouse = "a"
vim.o.smartcase = true
-- line number
vim.o.number = true
vim.o.relativenumber = true
-- Indentation settings
vim.o.tabstop = 2 -- Number of spaces that a <Tab> counts for
vim.o.shiftwidth = 2 -- Number of spaces to use for each step of (auto)indent
vim.o.expandtab = true -- Use spaces instead of tabs
vim.o.smartindent = true -- Enable smart indentation
vim.o.autoindent = true -- Copy indent from current line when starting a new line
vim.opt_local.cindent = false
vim.opt_local.smartindent = false
vim.o.cursorline = false
vim.o.termguicolors = true
vim.o.background = "dark"
vim.o.signcolumn = "yes"

vim.o.backspace = "indent,eol,start"

vim.o.splitright = true
vim.o.splitbelow = true

vim.opt.updatetime = 50
vim.o.wrap = true
vim.o.linebreak = true
vim.o.breakindent = true
vim.opt.scrolloff = 16
vim.opt.incsearch = true
vim.opt.hlsearch = false

vim.opt.swapfile = false
vim.opt.backup = false
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
vim.opt.undofile = true

vim.opt.foldcolumn = "0"
vim.opt.foldmethod = "manual"
vim.opt.foldtext = ""
vim.opt.foldlevel = 99
vim.opt.foldlevelstart = 1
vim.opt.foldnestmax = 4

-- Disable all filetype indent plugins globally
-- This prevents Neovim's built-in indent from conflicting with formatters
-- Since we use conform.nvim with format_on_save, we rely on formatters for indentation
-- vim.api.nvim_create_autocmd("FileType", {
-- 	pattern = "*",
-- 	callback = function()
-- 		vim.bo.indentexpr = ""
-- 	end,
-- })
