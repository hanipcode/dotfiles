--- Telescope pickers: live YouTube Music search + queue view.
local config = require("ytmusic.config")
local search = require("ytmusic.search")
local player = require("ytmusic.player")

local M = {}

local function displayer()
	local entry_display = require("telescope.pickers.entry_display")
	return entry_display.create({
		separator = "  ",
		items = {
			{ width = 42 },
			{ width = 24 },
			{ width = 20 },
			{ remaining = true },
		},
	})
end

local function make_entry_maker()
	local display = displayer()
	local function make_display(entry)
		return display({
			{ entry.value.title, "TelescopeResultsIdentifier" },
			{ entry.value.artist or "", "Comment" },
			{ entry.value.album or "", "NonText" },
			{ entry.value.duration_str or "", "Number" },
		})
	end
	return function(track)
		return {
			value = track,
			display = make_display,
			ordinal = table.concat({ track.title, track.artist or "", track.album or "" }, " "),
		}
	end
end

--- Custom async finder: debounces the prompt, runs curl via search.search,
--- kills superseded requests, ignores stale results.
local function live_finder(entry_maker)
	local uv = vim.uv or vim.loop
	local debounce = config.options.debounce
	local timer, inflight
	local gen = 0

	local function cancel()
		if timer then
			timer:stop()
			timer:close()
			timer = nil
		end
		if inflight then
			pcall(inflight.kill, inflight, 15)
			inflight = nil
		end
	end

	return setmetatable({ close = cancel }, {
		__call = function(_, prompt, process_result, process_complete)
			gen = gen + 1
			local my_gen = gen
			cancel()
			if not prompt or #prompt < 2 then
				process_complete()
				return
			end
			timer = uv.new_timer()
			timer:start(
				debounce,
				0,
				vim.schedule_wrap(function()
					if my_gen ~= gen then
						return
					end
					inflight = search.search(prompt, function(tracks)
						if my_gen ~= gen then
							return
						end
						inflight = nil
						for _, track in ipairs(tracks) do
							process_result(entry_maker(track))
						end
						process_complete()
					end)
				end)
			)
		end,
	})
end

--- Live search picker. <CR> play, <C-q> enqueue, <C-p> toggle pause.
--- Prefix the prompt with "v:" to search videos instead of songs.
function M.search(opts)
	opts = opts or {}
	local pickers = require("telescope.pickers")
	local sorters = require("telescope.sorters")
	local actions = require("telescope.actions")
	local action_state = require("telescope.actions.state")

	pickers
		.new({}, {
			prompt_title = "YouTube Music (v: for videos)",
			finder = live_finder(make_entry_maker()),
			previewer = false,
			-- keep YouTube Music's own ranking
			sorter = sorters.empty(),
			default_text = opts.query,
			attach_mappings = function(bufnr, map)
				actions.select_default:replace(function()
					local entry = action_state.get_selected_entry()
					if not entry then
						return
					end
					actions.close(bufnr)
					player.play(entry.value)
				end)
				map({ "i", "n" }, "<C-q>", function()
					local entry = action_state.get_selected_entry()
					if entry then
						player.enqueue(entry.value)
					end
				end)
				map({ "i", "n" }, "<C-p>", function()
					player.toggle()
				end)
				return true
			end,
		})
		:find()
end

--- Queue picker. <CR> jump to track, <C-d> remove from queue.
function M.queue()
	if #player.queue == 0 then
		vim.notify("[ytmusic] queue is empty", vim.log.levels.INFO)
		return
	end
	local pickers = require("telescope.pickers")
	local finders = require("telescope.finders")
	local conf = require("telescope.config").values
	local actions = require("telescope.actions")
	local action_state = require("telescope.actions.state")

	local entry_maker = make_entry_maker()
	local _, current_idx = player.current()

	pickers
		.new({}, {
			prompt_title = string.format("Queue (%d)%s", #player.queue, current_idx and "  ▶ #" .. current_idx or ""),
			finder = finders.new_table({
				results = player.queue,
				entry_maker = entry_maker,
			}),
			previewer = false,
			sorter = conf.generic_sorter({}),
			attach_mappings = function(bufnr, map)
				actions.select_default:replace(function()
					local entry = action_state.get_selected_entry()
					if not entry then
						return
					end
					actions.close(bufnr)
					player.play_index(entry.index)
				end)
				map({ "i", "n" }, "<C-d>", function()
					local entry = action_state.get_selected_entry()
					if not entry then
						return
					end
					player.remove_index(entry.index)
					actions.close(bufnr)
					M.queue()
				end)
				return true
			end,
		})
		:find()
end

return M
