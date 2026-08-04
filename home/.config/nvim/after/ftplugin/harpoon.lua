vim.keymap.set("v", "K", ":m '<-2<CR>gv", { buffer = true, silent = true, desc = "Move lines up (no indent)" })
vim.keymap.set("v", "J", ":m '>+1<CR>gv", { buffer = true, silent = true, desc = "Move lines down (no indent)" })
