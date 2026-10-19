function debounce(callback,delay = 500) {

  // define timer to hold id of timeout
  let timer;


  // returning function with passing callback arguments
  return function (...args) {

    // clearing out previous timer if any present
    clearTimeout(timer);

    // setting up timer with new callback function arguments with delay
    timer = setTimeout(() => {
      callback(this, args);
    }, delay);
  };
}

export default debounce;