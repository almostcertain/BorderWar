// Passwords refused at sign-up and password change (docs/accounts-auth.md §4).
// Only entries of 8+ characters matter, since anything shorter is already
// refused on length. Compared lower-cased.
'use strict';

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'pa55word', 'pa$$word', 'password!', 'password1!', 'password01', 'password11',
  '12345678', '123456789', '1234567890', '12345678910', '0123456789', '987654321', '9876543210',
  '87654321', '11111111', '00000000', '22222222', '33333333', '55555555', '66666666', '77777777',
  '88888888', '99999999', '12341234', '11223344', '12121212', '123123123', '123456789a',
  '1234qwer', '123qweasd', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', '1qazxsw2', 'q1w2e3r4',
  'q1w2e3r4t5', 'qwer1234', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwertyui', 'qwertyuiop',
  'qwertyuio', 'asdfghjk', 'asdfghjkl', 'asdfasdf', 'zxcvbnm1', 'zxcvbnm,', 'qazwsxedc',
  'abcd1234', 'abc12345', 'abc123456', 'abcdefgh', 'abcdefghi', 'abcdefg1', 'a1b2c3d4',
  'a1234567', 'a12345678', 'aa123456', 'aaaaaaaa', 'iloveyou', 'iloveyou1', 'iloveyou2',
  'iloveu12', 'ilovegod', 'ihateyou', 'loveyou1', 'lovelove', 'letmein1', 'letmein123',
  'welcome1', 'welcome12', 'welcome123', 'welcome!', 'admin123', 'admin1234', 'administrator',
  'adminadmin', 'root1234', 'changeme', 'changeme1', 'default1', 'temp1234', 'test1234',
  'testtest', 'testing1', 'testing123', 'guest123', 'login123', 'master12', 'master123',
  'sunshine', 'sunshine1', 'princess', 'princess1', 'football', 'football1', 'baseball',
  'baseball1', 'basketball', 'superman', 'superman1', 'batman123', 'spiderman', 'pokemon1',
  'pokemon123', 'starwars', 'starwars1', 'trustno1', 'whatever', 'whatever1', 'computer',
  'computer1', 'internet', 'internet1', 'michael1', 'michelle', 'jennifer', 'jessica1',
  'jordan23', 'charlie1', 'anthony1', 'matthew1', 'daniel12', 'william1', 'alexander',
  'samantha', 'victoria', 'elizabeth', 'benjamin', 'nicholas', 'christian', 'jonathan',
  'butterfly', 'chocolate', 'liverpool', 'liverpool1', 'arsenal1', 'chelsea1', 'manchester',
  'barcelona', 'mercedes', 'corvette', 'maverick', 'midnight', 'scorpion', 'airborne',
  'creative', 'startrek', 'swimming', 'dolphins', 'cowboys1', 'steelers', 'rangers1',
  'redskins', 'yankees1', 'hello123', 'hello1234', 'hellohello', 'monkey123', 'dragon123',
  'shadow123', 'killer123', 'fuckyou1', 'fuckyou2', 'fuckyou123', 'asshole1', 'blink182',
  'google123', 'facebook', 'facebook1', 'samsung1', 'minecraft', 'minecraft1', 'fortnite',
  'fortnite1', 'roblox123', 'borderwar', 'borderwar1', 'borderwar123', 'openfront',
  'secret123', 'security', 'passport', 'drowssap', 'november', 'december', 'september',
  'february', 'thursday', 'saturday', 'summer12', 'summer123', 'winter123', 'spring123',
  'qweasdzxc', 'qweqweqwe', 'asdasdasd', 'zaq12wsx', 'zaq1zaq1', '1q1q1q1q', '1a2b3c4d',
  '1234abcd', '123abc123', '12qwaszx', 'asdf1234', 'asdfqwer', 'qwerasdf', 'poiuytrewq',
  'mnbvcxz1', '147258369', '123654789', '789456123', '159753456', '1357924680', '112233445',
  '1122334455', '123321123', '12344321', '13579246', '10203040', '01234567', '0987654321',
  '1234512345', '111111111', '1111111111', '000000000', '0000000000', '123456123', 'a123456789'
]);

module.exports = { COMMON_PASSWORDS };
