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

### AI image posts (free)
- Provider: Pollinations.ai, Flux model — no API key, no cost
- Schedule: 1 post per day at a random time between 6–10 PM
- Scene selection: boosted by RAG velocity (monsoon trending → rain scene, AI/tech trending → coworking scene)
- To use DALL-E 3 instead: set `OPENAI_API_KEY` and `IMAGE_PROVIDER=openai` in `.env`

### Topic diversity
- 10% daily cap per topic (enforced in reply pipeline and fallback selection)
- Pune keyword weight reduced (was 3, now 1)
- Mumbai-Pune expressway removed from topic pool
- Tech/AI category weight boosted to 28%
- Velocity signal squared for much stronger RAG trend influence

## After restart
Check activity log at localhost:3000 for `IMAGE_SCHEDULE_CREATED` — confirms tonight's image post is scheduled.
