if vim.g.vscode then
  vscode = require("vscode");
  -- Open Problems panel
  map('n', '<leader>sp', '', {
    callback = function()
      vscode.action('workbench.action.togglePanel')
      vscode.action("workbench.actions.view.problems")
    end
  })

  map('n', '<leader>q', '', {
    callback = function()
      vscode.action("editor.action.quickFix")
    end
  });

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


  vim.keymap.set({ "n", "x", "i" }, "<leader>da", function()
    vscode.with_insert(function()
      vscode.action("editor.action.selectHighlights")
    end)
  end)

  -- select all occurence and enter insert
  vim.keymap.set({ "n", "x", "i" }, "<leader>di", function()
    vscode.with_insert(function()
      vscode.action("editor.action.addSelectionToNextFindMatch")
    end)
  end)

  vim.keymap.set('n', "<C-i>", function()
    vscode.action("workbench.action.navigateForward")
  end)

  vim.keymap.set('n', "<C-o>", function()
    vscode.action("workbench.action.navigateBack")
  end)

    -- Focus File Explorer
  map('n', '<leader>se', '', {
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

  map('n', '<leader>[i', '', {
    callback = function()
      vscode.action("workbench.action.compareEditor.nextChange")
      vscode.action("workbench.action.editor.nextChange")
    end
  });

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

  map('n', '<leader>{t', '', {
    callback = function()
      vscode.action("extension.surroundWithTag")
    end
  })
end
