-- Set leader key
vim.g.mapleader = ' '

-- Set options
vim.o.ignorecase = true
vim.o.smartcase = true
-- line number
vim.o.number = true 
vim.o.relativenumber = true
-- Indentation settings
vim.o.tabstop = 2                  -- Number of spaces that a <Tab> counts for
vim.o.shiftwidth = 2               -- Number of spaces to use for each step of (auto)indent
vim.o.expandtab = true             -- Use spaces instead of tabs
vim.o.smartindent = true           -- Enable smart indentation
vim.o.autoindent = true            -- Copy indent from current line when starting a new line


-- Key mappings
local map = vim.api.nvim_set_keymap

-- Define getOpts function
local function getOpts()
  if vim.g.vscode then
    return {}
  else
    return { noremap = true, silent = true }
  end
end


-- Mappings using getOpts function
map('n', '<C-d>', '<C-d>zz', getOpts())
map('n', '<C-u>', '<C-u>zz', getOpts())
map('n', '<leader>cl', ':noh<CR><CR>', getOpts())
map('n', '<leader>y', '"+y', getOpts())
map('v', '<leader>y', '"+y', getOpts())
map('n', '<leader>p', '"+gP', getOpts())
map('v', '<leader>p', '"+gP', getOpts())


if vim.g.vscode then
  vscode = require("vscode");
  -- Open Problems panel
  map('n', '<leader>p', '', {
    callback = function()
      vscode.action('workbench.action.togglePanel')
      vscode.action("workbench.actions.view.problems")
    end
  })

  -- Go to next problem
  map('n', '<leader>ei', '', {
    callback = function()
      vscode.action("editor.action.marker.next")
    end
  })

  -- Go to previous problem
  map('n', '<leader>eo', '', {
    callback = function()
      vscode.action("editor.action.marker.prev")
    end
  })
  -- muklti cursor
  vim.keymap.set({ "n", "x", "i" }, "<leader>d", function()
    vscode.with_insert(function()
      vscode.action("editor.action.selectHighlights")
    end)
  end)

    -- Focus File Explorer
  map('n', '<leader>e', '', {
    callback = function()
      vscode.action('workbench.files.action.focusFilesExplorer')
    end
  })


  map('n', '<leader>[c', '', {
    callback = function()
      vscode.action("git.openChange")
    end
  })


  map('n', '<leader>[w', '', {
    callback = function()
      vscode.action("git.closeAllDiffEditors")
    end
  })

  map('n', '<leader>[k', '', {
    callback = function()
      vscode.action("merge-conflict.next")
    end
  })

  map('n', '<leader>[l', '', {
    callback = function()
      vscode.action("mege-conflict.prev")
    end
  })

  map('n', '<leader>[,', '', {
    callback = function()
      vscode.action("merge-conflict.accept.current")
    end
  })

  map('n', '<leader>[.', '', {
    callback = function()
      vscode.action("merge-conflict.accept.incoming")
    end
  })



end
