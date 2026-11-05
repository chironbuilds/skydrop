"""One-off: moves the old single-page site's prose and code into doc pages, corrected for Ootle 0.49."""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
old = (root / "legacy" / "index-2026-10-28.html").read_text(encoding="utf-8")


def section(name: str) -> str:
    m = re.search(rf'<section[^>]*id="{name}"[^>]*>\s*<div class="wrap">(.*?)</div>\s*</section>', old, re.S)
    assert m, name
    body = m.group(1)
    body = re.sub(r'\s*<span class="kicker">.*?</span>', "", body, count=1, flags=re.S)
    body = re.sub(r"<h2>(.*?)</h2>", r"<h1>\1</h1>", body, count=1, flags=re.S)
    return body.strip()


def must_sub(text: str, old_s: str, new_s: str) -> str:
    assert old_s in text, old_s
    return text.replace(old_s, new_s)


K = '<span class="tok-k">let</span>'
what = section("what")
what = must_sub(what, "Audited; see the trust boundaries below.", 'Reviewed internally, with no third-party audit yet. See the <a href="/docs/security">trust boundaries</a>.')
verify = section("verify")
verify = re.sub(r"<h1>.*?</h1>", '<h2 id="menu">Everything a contract can prove</h2>', verify, count=1, flags=re.S)
verify = verify.replace('class="section-lede"', 'class="section-lede"')
overview = what + "\n" + verify + """
<h2>Where to go next</h2>
<ul>
  <li><a href="/campaigns">Run a campaign</a> without writing any code.</li>
  <li><a href="/verify">Watch a proof run</a> on a real account.</li>
  <li><a href="/docs/integrate">Write your own policy</a> on the same layer.</li>
</ul>
"""
overview = overview.replace('<div class="grid cols-3">', '<div class="grid g3">')

arch = section("arch")

integrate = section("integrate")
# 0.49: signers are checked as in-scope badges, and a proof shown to a callee stays with its creator, who drops it.
integrate = must_sub(
    integrate,
    '<span class="tok-f">CallerContext</span>::<span class="tok-f">get_signer_proof_for_public_key</span>(claimant).<span class="tok-f">drop</span>();'
    if '<span class="tok-f">CallerContext</span>' in integrate
    else 'CallerContext::<span class="tok-f">get_signer_proof_for_public_key</span>(claimant).<span class="tok-f">drop</span>();',
    'CallerContext::<span class="tok-f">assert_badge_in_scope</span>(&amp;NonFungibleAddress::<span class="tok-f">from_public_key</span>(claimant));',
)
integrate = must_sub(
    integrate,
    '<span class="tok-k">let</span> paid: <span class="tok-t">Bucket</span> = ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow)\n    .<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, account_id, index]);',
    '<span class="tok-k">let</span> paid: <span class="tok-t">Bucket</span> = ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow)\n    .<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, account_id, index]);\n<span class="tok-c">// since Ootle 0.49 a proof shown to a callee stays yours: drop it or the transaction fails</span>\nproof.<span class="tok-f">drop</span>();',
)
integrate = must_sub(
    integrate,
    'ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">call</span>::&lt;_, ()&gt;(<span class="tok-s">"release_to"</span>, args![proof, did, index, wallet]);',
    'ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">invoke</span>(<span class="tok-s">"release_to"</span>, args![proof, did, index, wallet]);\n            proof.<span class="tok-f">drop</span>();',
)
integrate = must_sub(
    integrate,
    '<span class="tok-k">let</span> wallet: <span class="tok-t">ComponentAddress</span> = registry.<span class="tok-f">call</span>::&lt;_, <span class="tok-t">Option</span>&lt;_&gt;&gt;(<span class="tok-s">"binding_for"</span>, args![did.<span class="tok-f">clone</span>()])\n                .<span class="tok-f">expect</span>(<span class="tok-s">"link a wallet first"</span>);',
    '<span class="tok-k">let</span> wallet: <span class="tok-t">Option</span>&lt;<span class="tok-t">ComponentAddress</span>&gt; = registry.<span class="tok-f">call</span>(<span class="tok-s">"binding_for"</span>, args![did.<span class="tok-f">clone</span>()]);\n            <span class="tok-k">let</span> wallet = wallet.<span class="tok-f">expect</span>(<span class="tok-s">"link a wallet first"</span>);',
)
integrate = must_sub(
    integrate,
    'ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, campaign, idx])\n}',
    '<span class="tok-k">let</span> paid: <span class="tok-t">Bucket</span> = ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, campaign, idx]);\n    proof.<span class="tok-f">drop</span>();\n    paid\n}',
)
integrate = must_sub(
    integrate,
    '<span class="tok-k">let</span> b: <span class="tok-t">Bucket</span> = ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, did.<span class="tok-f">clone</span>(), i]);',
    '<span class="tok-k">let</span> b: <span class="tok-t">Bucket</span> = ComponentManager::<span class="tok-f">get</span>(<span class="tok-k">self</span>.escrow).<span class="tok-f">call</span>(<span class="tok-s">"release"</span>, args![proof, did.<span class="tok-f">clone</span>(), i]);\n    proof.<span class="tok-f">drop</span>();',
)
integrate = must_sub(
    integrate,
    'The funder tops the pool up by escrowing more slots with the same metadata under the same campaign id;',
    'This slot pool is limited to 64 slots per campaign by the Escrow\'s per-policy cap. For anything larger, use the <a href="/docs/campaign">Campaign contract</a>, which has no such limit. The funder tops the pool up by escrowing more slots with the same metadata under the same campaign id;',
)
integrate = integrate.replace('<p class="flow-note">Because the payout is fixed', '<p class="flow-note">Because the payout is fixed')
intro = """<div class="note"><strong>Just want to pay people for doing things on Bluesky?</strong> You don't need a policy for that: the <a href="/docs/campaign">Campaign contract</a> covers it with no code. Write a policy when you need custom logic. All code below is for Ootle 0.49.</div>
"""
integrate = re.sub(r"(<h1>.*?</h1>)", lambda m: m.group(1) + "\n" + intro, integrate, count=1, flags=re.S)

sky = section("skydrop")
sky = sky.replace('<div class="grid cols-3">', '<div class="grid g3">')
sky = must_sub(
    sky,
    'Skydrop is live at <a href="https://skydrop.tari.mw">skydrop.tari.mw</a>. It is exactly one policy on the shared escrow.',
    'The app is at <a href="https://skydrop.tari.mw">skydrop.tari.mw</a>, but its contracts date from before the network\'s 0.49 reset, and moving it across is <a href="/status">still to do</a>. In the new design it is exactly one policy on the shared escrow.',
)

for name, html in {"overview": overview, "architecture": arch, "integrate": integrate, "skydrop": sky}.items():
    (root / "src" / "docs" / f"{name}.html").write_text(html.strip() + "\n", encoding="utf-8", newline="\n")
    print(name, len(html))
