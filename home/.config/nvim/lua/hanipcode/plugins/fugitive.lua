return {
	{
		"tpope/vim-fugitive",
		config = function()
			vim.keymap.set("n", "<leader>go", vim.cmd.Git)

			-- Conflict resolution: get changes from left (target/ours) or right (merge/theirs)
			vim.keymap.set("n", "gu", "<cmd>diffget //2<CR>")
			vim.keymap.set("n", "gh", "<cmd>diffget //3<CR>")

			-- Better workflow: use dp (diffput) from the middle window to choose which version to keep
			-- Or use these in the middle (working copy) window:
			vim.keymap.set("n", "<leader>gj", "<cmd>diffget //3<CR>]c", { desc = "Get from right and next conflict" })
			vim.keymap.set("n", "<leader>gf", "<cmd>diffget //2<CR>]c", { desc = "Get from left and next conflict" })

			vim.keymap.set("n", "<leader>gm", function()
				local pickers = require("telescope.pickers")
				local finders = require("telescope.finders")
				local conf = require("telescope.config").values
				local actions = require("telescope.actions")
				local action_state = require("telescope.actions.state")
				local previewers = require("telescope.previewers")

				-- Function to abbreviate time
				local function abbreviate_time(time_str)
					local time = time_str:gsub(" ago", "")
					time = time:gsub("seconds?", "s")
					time = time:gsub("minutes?", "m")
					time = time:gsub("hours?", "h")
					time = time:gsub("days?", "d")
					time = time:gsub("weeks?", "w")
					time = time:gsub("months?", "mo")
					time = time:gsub("years?", "y")
					time = time:gsub("%s+", "")
					return time
				end

				-- Get branches sorted by recency
				local handle = io.popen(
					"git for-each-ref --sort=-committerdate refs/heads/ --format='%(committerdate:relative)|%(refname:short)'"
				)
				local result = handle:read("*a")
				handle:close()

				local branches = {}
				for line in result:gmatch("[^\r\n]+") do
					local date, branch = line:match("([^|]+)|(.+)")
					if branch then
						local abbrev_date = abbreviate_time(date)
						table.insert(branches, {
							date = abbrev_date,
							branch = branch,
							display = abbrev_date .. " - " .. branch,
						})
					end
				end

				pickers
					.new({}, {
						prompt_title = "Git Branches (by recency)",
						finder = finders.new_table({
							results = branches,
							entry_maker = function(entry)
								return {
									value = entry.branch,
									display = entry.display,
									ordinal = entry.display,
								}
							end,
						}),
						sorter = conf.generic_sorter({}),
						initial_mode = "normal",
						previewer = previewers.new_termopen_previewer({
							get_command = function(entry)
								return { "git", "show", "--pretty=fuller", entry.value }
							end,
						}),
						attach_mappings = function(prompt_bufnr, map)
							actions.select_default:replace(function()
								actions.close(prompt_bufnr)
								local selection = action_state.get_selected_entry()
								vim.cmd("Git checkout " .. selection.value)
							end)

							-- Add 'p' mapping to open PR for the selected branch
							map("n", "p", function()
								local selection = action_state.get_selected_entry()
								local branch = selection.value
								-- Open PR for this branch using gh cli (stay in picker)
								vim.fn.system("gh pr view --web " .. vim.fn.shellescape(branch) .. " 2>/dev/null || gh pr create --web --head " .. vim.fn.shellescape(branch))
							end)

							return true
						end,
					})
					:find()
			end, { desc = "Git branches by recency" })
		end,
	},
	{
		"tpope/vim-rhubarb",
		dependencies = { "tpope/vim-fugitive" },
	},
}
