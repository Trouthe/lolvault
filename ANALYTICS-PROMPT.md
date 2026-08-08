Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
https://claude.ai/design/p/76802cdd-235b-433f-b9fa-8e82f7c8f0b6?file=LoL+Vault.dc.html

Focus on these files (the whole project is readable):

- `LoL Vault.dc.html`

Also read these files the selection imports:

- `assets/branding/LV-no-bg_dark.svg`
- `assets/icons/grip.svg`
- `assets/icons/plus.svg`
- `assets/icons/search.svg`
- `assets/icons/settings.svg`
- `assets/icons/sort.svg`
- `assets/icons/trash.svg`
- `support.js`

Implement: `LoL Vault.dc.html`

HERE'S WHAT YOU NEED TO DO:

We now need to implement the all new and redesigned Analytics page. EVERYTHING in it should be ACTUALLY functional and NOT placeholders – we need empty states if some things are NOT available.
Few key things to keep in mind, we do not have to follow everything to a T, some things are still bad on the Claude Design file and we will continuously iterate over it together together here.

Key Notes For The Implementation:

- **Overview screen**:
  - We need to implement this screen as the tweak says `analyticsLeft: sidebar` so when we open an account it overrides the left side. But the top left section looks VERY VERY bad currently with the way we're showing the back button and the branding and such. So it's up to YOU to drastically **improve** it as you see fit. 
  - We need to improve the UI of the switcher between Overview & Analytics. And we also need to add a new screen in between called Champions – which we will go over in more details below – which would make the overall kind of it -> Overview / Champions / Analytics
  - Left side is mostly the same stuff I want you to implement into our app, nothing much to say about it other than ofc adding interractibility to the graphs like on hover showcase how many days ago the hovered segment was with the rank and LP i was on that day and ofc the date itself
  - **ROLE PERFORMANCE**: I'm pretty sure we can move this into the top section somewhere above the match history, it doesn't really look good sitting there on the left side, i'm not sure. Do your analysis and if you see it's better to stay on the left side, then keep it, otherwise move it. Your call.
  - **MOST PLAYED CHAMPIONS**: Should have a toggle for each mode like Total, Ranked solo, flex, 5v5.
  - **RECENTLY PLAYED WITH**: it should have a clear typography for the last how many games we're checking against, I want a toggle to switch between played WITH and played AGAINST I think that's a cool addition to it – also don't forget about the hover interactions
- **Match History Game Cards**:
  - **HEATMAP**: we should use this map (minimap_summoners-rift.png), IF WE CAN from game data and such (SEE: https://demoriarty.github.io/LeagueHeatmap/ (we need to implement the things we have there as much as possible with real data from our games such as the heatmap, the timeline slider, the stepper (choosing every 5 mins, or choosing to see past 15mins for example how our gameplay moves, etcetc) but not the design they have I think because we could make it better.)), to have data of where on the map you were mostly positioned and stuff it would be AMAZING, like as a katarina mid player I could see if my roams were better or not through this heatmap, if i was tunnel visioning mostly onto one place and didn't swap and play onto other lanes, etcetc. We should also showcase X for kills and skull for deaths, towers and inhib I killed, etcetc (try as much as possible using assets from the game itself. See NOTES for more info).
  - **BUILD**: We should be able to switch between players and see their build path and skills order
  - **TEAM ANALYTICS & PERFORMANCE**: I think these two, with good UX/UI, could be merged into one called "PERFORMANCE", which will contain the things they have and we can click left side for us and right side for enemy (check screenshots) and display the comparison between the two and such.
  - **OVERVIEW**: Self explanatory, the total gold on hover should show a graph (check screenshots) showcasing if the team was losing and then pulled through etcetc. It should also have a banned champion list for each team, who they banned and such (check screenshots) along ofc the middle having the objectives and kills and such.
- **Analytics screen**:
  - i mostly want everything in it for the time being, more info on this later, you COULD simply skip (?) it for now and add a note for implementation later as I think this prompt is already complicated enough. 

\*NOTES:

- You have permission to do commits and pushes ONLY to THIS branch of `analytics` – **DO NOT CREATE ANY OTHER BRANCH** – Make your commit messages consise and one liners, and commit frequently after implementing each milestone or feature etc. 
- **Do NOT implement anything CLASH related.**
- For more inspiration, i have attached screenshots on how things should be looking like when we open the match information, everything should be interactible for the most part like the comparison between champs, the graphs, the stuff etc.
- For assets, please look at https://developer.riotgames.com/docs/lol and other community(?) sources for the best way to implement the assets. Either through downloading them locally and fallbacking to the online stuff if for example new champion gets released and our dataset is stale and doesn't have it, etc. Or if it's gonna make the application way too big or what. You are the boss here and you make the decisions, just let me know WHY you made such decisions.
- Good to have sources: https://maknee.github.io/blog/2025/League-Data-Scraping/#current-datasets-and-their-issues, https://github.com/noxelisdev/LoL_DDragon
