function faceSection(headingId, title, searchId, messageKey) {
  return {
    type: 'section',
    items: [
      {
        type: 'heading',
        id: headingId,
        defaultValue: title,
      },
      {
        type: 'input',
        id: searchId,
        label: 'Watchface',
        attributes: {
          type: 'text',
          placeholder: 'Search by name',
          autocomplete: 'off',
        },
      },
      {
        type: 'select',
        messageKey: messageKey,
        label: 'Face',
        options: [],
      },
    ],
  };
}

module.exports = [
  {
    type: 'heading',
    defaultValue: 'Quiet Face Swap',
  },
  {
    type: 'section',
    items: [
      {
        type: 'heading',
        defaultValue: 'Automatic swaps',
      },
      {
        type: 'select',
        messageKey: 'autoSwap',
        label: 'Mode',
        defaultValue: '1',
        options: [
          { label: 'Off (button only)', value: '0' },
          { label: 'With Quiet Time', value: '1' },
          { label: 'Sunrise, sunset and button', value: '2' },
          { label: 'Sunrise and sunset only', value: '3' },
        ],
        description: ' ',
      },
    ],
  },
  {
    type: 'text',
    defaultValue: 'Search the Core and Rebble app stores for faces that work on this watch. ' +
      'Choose faces already in your locker, or the swap will fail.',
  },
  faceSection('firstFaceHeading', 'Quiet Time on', 'quietSearch', 'quietFace'),
  faceSection('secondFaceHeading', 'Quiet Time off', 'normalSearch', 'normalFace'),
  {
    type: 'submit',
    defaultValue: 'Save',
  },
];
