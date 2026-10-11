# End-to-end test checklist

A walk through every feature with real accounts on the Esmeralda testnet. You need a Bluesky account (call it
**Alice**), a second one to send from (**Bob**, or the build wallet's CLI) and a few tTARI.

1. **Plain gift, unlinked.** Bob sends 0.1 tTARI to Alice with an envelope and a note. The bot mentions Alice with the
   same envelope card. Alice opens the link, posts the claim line, waits for the claim to verify and collects it.
2. **Link.** Alice opens Link wallet, posts the shown line and waits for "Link submitted". About two epochs later it
   is active (the page moves on by itself in challenge mode).
3. **Instant gift.** Bob sends 0.1 tTARI again. It goes straight to Alice's wallet: Bob sees "Delivered instantly",
   the bot posts "You received…", and Alice has nothing to collect.
4. **Challenge.** Bob sends with a phrase (try an hold time of 1 hour as well). Alice sees the three-step bar, posts
   only the phrase as a new post, and the money is released to her linked wallet. With a hold time: wait, do any
   action on Bluesky so a fresh snapshot is saved, then press "Confirm my post is still up".
5. **Decline.** Bob sends a phrase gift. Alice opens Collect, declines it from her linked wallet. Bob's "Your sends"
   shows "Returned"; he takes it back.
6. **Sweep.** Send a phrase gift and leave it for 72 epochs; anyone can press "Return expired gifts".
7. **Tip by post.** Bob funds a budget, then posts `@taridrop.bsky.social tip @alice 1`. The bot relays it and replies.
8. **Stolen key (needs a spare account).** Link an account, then rotate its signing key before the link takes effect
   using an older chain; the bot should log "cancelling a link … operation chain has changed".
9. **Language and theme.** Switch to 中文 and to dark mode from the settings menu on each page; check the header
   fits at 360 px wide.

Automated: `./run_tests.sh` runs the contract engine tests (36).
