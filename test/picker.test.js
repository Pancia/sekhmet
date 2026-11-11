// picker.js: the parts that decide what a rule is built from. The page side is
// exercised in a real browser by test/picker-page.html; these need no DOM.
const P = require('../picker.js');
const { group, ok, done } = require('./assert');

group('hashed names are hidden, word-like names are kept');
{
    const hashed = ['css-1x2y3z', 'Button_root__a1B2c', 'x1lliihq', 'hs0', 'un8', 'TB_', 'jzS',
        'sc-bdVaJa', 'kVc4', 'XiGzPq', ':r1:', '_3fGh', 'jsx-123456', 'xjbqbw'];
    const words = ['feed', 'pin', 'ad', 'feedItemCard', 'MuiButton-root', 'item12', 'mt-4',
        'related-pins', 'post-123456', 'sponsored'];
    hashed.forEach(t => ok(`${t} is hashed`, P.isGeneratedToken(t)));
    words.forEach(t => ok(`${t} is kept`, !P.isGeneratedToken(t)));
}

group('procedural rules split into the CSS part and the operators');
{
    const p = P.parseProcedural('div[data-test-id="pin"]:has-text(Promoted):upward(2)');
    ok('base', p.base === 'div[data-test-id="pin"]');
    ok('two operators', p.ops.length === 2 && p.ops[0].name === 'has-text' && p.ops[0].arg === 'Promoted' && p.ops[1].arg === '2');

    const native = P.parseProcedural('div:has(> a):not(.x)');
    ok('native :has and :not stay CSS', native.base === 'div:has(> a):not(.x)' && native.ops.length === 0);

    const inner = P.parseProcedural('div:not(:has-text(Ad)) > span');
    ok('leftover text after an operator is refused', inner === null);

    const proc = P.parseProcedural('article:has(span:has-text(Sponsored))');
    ok(':has with a procedural argument is an operator', proc.base === 'article' && proc.ops[0].name === 'has' && proc.ops[0].arg === 'span:has-text(Sponsored)');

    const re = P.parseProcedural('a:has-text(/a\\)b|c(d)/i)');
    ok('a ) escaped inside a regex does not end the argument', re.ops[0].arg === '/a\\)b|c(d)/i');

    const attr = P.parseProcedural('[aria-label="a:has-text(x)"]');
    ok('an operator name inside an attribute value is not an operator', attr.ops.length === 0);
}

group('text arguments');
{
    ok('plain is a substring', P.textMatcher('Promo')('Promoted pin'));
    ok('regex with flags', P.textMatcher('/^sponsored$/i')('Sponsored'));
    ok('regex anchors hold', !P.textMatcher('/^sponsored$/i')('Not sponsored'));
}

group('the copied rule');
{
    ok('www. dropped', P.toFilter('www.pinterest.com', '[data-test-id="pin"]') === 'pinterest.com##[data-test-id="pin"]');
    ok('other subdomains kept', P.toFilter('m.example.org', 'div') === 'm.example.org##div');
}

done();
