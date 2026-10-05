# Notes for Claude

## Kitchen / grocery memory
The user keeps a persistent record of their groceries and recipes in `kitchen/`:

- `kitchen/staples.md`: what they typically buy and store.
- `kitchen/recipes/`: recipes they've shared (ingredients + directions).

At the start of any grocery, meal-planning or recipe request, read these
first. When the user shares a new recipe or says their staples changed, update
the files, commit and push to the working branch. Don't open a PR unless asked.

When the user asks for help generating a grocery list, ask them whether they
want to incorporate any recipes from `kitchen/recipes/`. List the recipe names
as options. Then add the chosen recipes' ingredients to the list, minus what
`kitchen/staples.md` and current inventory photos show they already have.
