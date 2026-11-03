// Runs inside the Clay settings page. Clay copies this function's source into the page, so it
// can't use anything outside its own body.
//
// Each face is one search box with a results list under it. Clay's select stays hidden behind it,
// because Clay saves that value.
module.exports = function () {
  var clayConfig = this;
  var SEARCH_DELAY_MS = 800;
  var MINIMUM_QUERY_LENGTH = 3;
  var WORKER_NOTE = ' This uses the watch\'s one background worker slot, and a swap can interrupt ' +
    'whatever is on screen.';
  var LOCATION_NOTE = ' Sunrise and sunset use your phone\'s location, which stays on your phone.';
  var MODES = {
    0: {
      first: 'Quiet Time on',
      second: 'Quiet Time off',
      description: 'The button toggles Quiet Time and swaps the face. Nothing changes the face ' +
        'automatically.',
    },
    1: {
      first: 'Quiet Time on',
      second: 'Quiet Time off',
      description: 'The face follows Quiet Time, including schedules, calendar events and the ' +
        'normal toggle.' + WORKER_NOTE,
    },
    2: {
      first: 'Night or Quiet Time on',
      second: 'Day or Quiet Time off',
      description: 'The face changes at sunrise and sunset. The button toggles Quiet Time and ' +
        'swaps the face until the next sunrise or sunset.' + LOCATION_NOTE + WORKER_NOTE,
    },
    3: {
      first: 'Night',
      second: 'Day',
      description: 'The face changes at sunrise and sunset, and ignores Quiet Time. The button ' +
        'only toggles Quiet Time.' + LOCATION_NOTE + WORKER_NOTE,
    },
  };
  var STYLES =
    '.face-search input { background: #fff !important; color: #000 !important; }' +
    '.face-search input::placeholder { color: #666; }' +
    '.face-results { display: none; margin: 2px 0.7rem 0.7rem; border-radius: 0.25rem; background: #fff;' +
    ' color: #000; overflow: hidden; }' +
    '.face-results.open { display: block; }' +
    '.face-results button, .face-results p { display: block; box-sizing: border-box; width: 100%;' +
    ' min-width: 0; height: auto; margin: 0; padding: 0.6rem 0.375rem; border: 0; border-radius: 0;' +
    ' border-top: 1px solid #ddd; background: #fff; color: #000; font: inherit; letter-spacing: 0;' +
    ' text-align: left; text-transform: none; box-shadow: none; }' +
    '.face-results :first-child { border-top: 0; }' +
    '.face-results p { color: #555; }';

  function addStyles() {
    var style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function titleOf(choice) {
    return choice.slice(choice.indexOf('|') + 1);
  }

  function setUpFace(messageKey, searchId) {
    var faceItem = clayConfig.getItemByMessageKey(messageKey);
    var select = faceItem.$manipulatorTarget[0];
    var searchItem = clayConfig.getItemById(searchId);
    var searchInput = searchItem.$manipulatorTarget[0];
    var results = document.createElement('div');
    var chosen = clayConfig.meta.userData[messageKey] || '';
    var timer = null;
    var latestSearch = 0;
    var lastQuery = '';

    function saveChoice() {
      select.innerHTML = '';
      var option = document.createElement('option');
      option.value = chosen;
      select.appendChild(option);
      faceItem.set(chosen);
    }

    function closeResults() {
      clearTimeout(timer);
      latestSearch += 1;
      lastQuery = '';
      results.className = 'face-results';
      results.innerHTML = '';
      searchInput.value = chosen ? titleOf(chosen) : '';
    }

    function showMessage(message) {
      results.innerHTML = '';
      var line = document.createElement('p');
      line.textContent = message;
      results.appendChild(line);
      results.className = 'face-results open';
    }

    function addResult(face) {
      var row = document.createElement('button');
      row.type = 'button';
      row.textContent = face.author ? face.title + ' by ' + face.author : face.title;
      // Stops the box losing focus first, which would close the list before the tap lands.
      row.addEventListener('mousedown', function (event) {
        event.preventDefault();
      });
      row.addEventListener('click', function () {
        chosen = face.uuid + '|' + face.title;
        saveChoice();
        closeResults();
        searchInput.blur();
      });
      results.appendChild(row);
    }

    function showReply(reply) {
      if (reply.limited) {
        showMessage('Too many searches. Wait a minute');
      } else if (reply.results.length) {
        results.innerHTML = '';
        reply.results.forEach(addResult);
        results.className = 'face-results open';
      } else {
        showMessage(reply.failed ? 'Search failed. Try again' : 'No faces found');
      }
    }

    function search() {
      var query = searchInput.value.trim();
      var thisSearch = ++latestSearch;
      if (query.length < MINIMUM_QUERY_LENGTH || query === lastQuery) {
        return;
      }
      if (!window.Pebble || !Pebble.sendMessage) {
        showMessage('Turn on the plugins preview to search');
        return;
      }
      lastQuery = query;
      showMessage('Searching...');
      Pebble.sendMessage('pkjs', { type: 'search', query: query }).then(function (reply) {
        if (reply.limited || reply.failed) {
          lastQuery = '';
        }
        if (thisSearch === latestSearch) {
          showReply(reply);
        }
      }).catch(function () {
        lastQuery = '';
        if (thisSearch === latestSearch) {
          showMessage('Search failed. Try again');
        }
      });
    }

    results.className = 'face-results';
    searchItem.$element[0].appendChild(results);
    searchItem.$element[0].className += ' face-search';
    faceItem.hide();
    saveChoice();
    searchInput.value = chosen ? titleOf(chosen) : '';

    searchInput.addEventListener('focus', function () {
      searchInput.select();
    });
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(search, SEARCH_DELAY_MS);
    });
    searchInput.addEventListener('blur', closeResults);
  }

  function showMode() {
    var modeItem = clayConfig.getItemByMessageKey('autoSwap');
    var mode = MODES[modeItem.get()] || MODES[1];
    clayConfig.getItemById('firstFaceHeading').set(mode.first);
    clayConfig.getItemById('secondFaceHeading').set(mode.second);
    modeItem.$element[0].querySelector('.description').textContent = mode.description;
  }

  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    addStyles();
    showMode();
    clayConfig.getItemByMessageKey('autoSwap').on('change', showMode);
    setUpFace('quietFace', 'quietSearch');
    setUpFace('normalFace', 'normalSearch');
  });
};
