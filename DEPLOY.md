# Xposter — Deploy commands

All changes are built and compiled. Run in Terminal to activate:

```bash
cd ~/Xposter
rm -f .git/HEAD.lock .git/index.lock
git add -A
git commit -m "feat: image posts + topic diversity"
git push origin HEAD:main
launchctl stop com.akshay.xposter && sleep 4 && launchctl start com.akshay.xposter
```

## What's new

### AI image posts
- Provider chain (preferred first): **fal.ai** (`FAL_KEY`) → Gemini → OpenAI → Hugging Face → Pollinations (free safety net)
- fal hosts nano-banana-2 (same family as gemini-3.1-flash-image) with no Google minimum spend
- Style anchors upload to the fal CDN (`FAL_REFERENCE_MODE=upload`); `datauri` / `off` are alternatives
- Schedule: up to `image_posts_per_day` slots in the evening window (default 18–22), gated by vision QA
- Scene selection: boosted by RAG velocity when context is enabled
- Monthly spend is capped (`image_monthly_budget_usd`) with a daily burst allowance so the budget lasts the month

### Topic diversity
- 10% daily cap per topic (enforced in reply pipeline and fallback selection)
- Pune keyword weight reduced (was 3, now 1)
- Mumbai-Pune expressway removed from topic pool
- Tech/AI category weight boosted to 28%
- Velocity signal squared for much stronger RAG trend influence

## After restart
Check activity log at localhost:3000 for `IMAGE_SCHEDULE_CREATED` — confirms tonight's image post is scheduled.
