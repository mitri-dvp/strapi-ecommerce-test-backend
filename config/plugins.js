/* eslint-disable linebreak-style */
module.exports = ({ env }) => {

  if(env('NODE_ENV') === 'production') {
    return {
      upload: {
        provider: 'cloudinary',
        providerOptions: {
          cloud_name: env('CLOUDINARY_NAME'),
          api_key: env('CLOUDINARY_KEY'),
          api_secret: env('CLOUDINARY_SECRET'),
        },
      },
    };
  }

  return {
    
  };
};