// Length-prefixed UTF-8 stdin. Credentials are never command-line arguments.
#include <windows.h>
#include <winnetwk.h>
#include <iostream>
#include <string>
#include <vector>
#include <cstdint>
#include <algorithm>
#include <fcntl.h>
#include <io.h>
static std::wstring readField(){
  std::uint32_t n=0;std::cin.read(reinterpret_cast<char*>(&n),4);
  if(!std::cin||n>16384)throw 1;
  std::string bytes(n,'\0');std::cin.read(bytes.data(),n);if(!std::cin)throw 1;
  int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(n),nullptr,0);
  if(n&&count<=0)throw 1;std::wstring value(count,L'\0');
  MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),static_cast<int>(n),value.data(),count);
  SecureZeroMemory(bytes.data(),bytes.size());if(value.find(L'\0')!=std::wstring::npos)throw 1;return value;
}
static std::string escaped(const std::wstring& value){
  int n=WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);
  std::string bytes(n,'\0'),out;WideCharToMultiByte(CP_UTF8,0,value.data(),static_cast<int>(value.size()),bytes.data(),n,nullptr,nullptr);
  for(unsigned char c:bytes){if(c=='\\'||c=='"')out+='\\';if(c<32)out+=' ';else out+=static_cast<char>(c);}return out;
}
static std::vector<std::wstring> connections(DWORD& error){
  HANDLE handle=nullptr;std::vector<std::wstring> result;
  error=WNetOpenEnumW(RESOURCE_CONNECTED,RESOURCETYPE_DISK,0,nullptr,&handle);if(error!=NO_ERROR)return result;
  std::vector<BYTE> buffer(65536);
  for(;;){DWORD count=0xffffffff,size=static_cast<DWORD>(buffer.size());DWORD code=WNetEnumResourceW(handle,&count,buffer.data(),&size);
    if(code==ERROR_NO_MORE_ITEMS)break;
    if(code==ERROR_MORE_DATA&&size<=1024*1024){buffer.resize(size);continue;}
    if(code!=NO_ERROR){error=code;break;}
    auto rows=reinterpret_cast<NETRESOURCEW*>(buffer.data());
    for(DWORD i=0;i<count;++i)if(rows[i].lpRemoteName){std::wstring name=rows[i].lpRemoteName;if(std::find(result.begin(),result.end(),name)==result.end())result.push_back(name);}
  }
  WNetCloseEnum(handle);return result;
}
int main(){
  _setmode(_fileno(stdin),_O_BINARY);
  try{
    auto action=readField(),share=readField(),username=readField(),password=readField();
    DWORD code=ERROR_INVALID_PARAMETER;
    if(share.rfind(L"\\\\",0)!=0||share.find(L'\\',2)==std::wstring::npos)throw 1;
    if(action==L"list"){
      DWORD enumerationError=0;const auto rows=connections(enumerationError);
      std::cout<<"{\"errorCode\":"<<enumerationError<<",\"shares\":[";
      for(size_t i=0;i<rows.size();++i){if(i)std::cout<<',';std::cout<<'"'<<escaped(rows[i])<<'"';}
      std::cout<<"],\"complete\":false}";return 0;
    }
    if(action==L"disconnect")code=WNetCancelConnection2W(share.c_str(),0,FALSE);
    if(action==L"connect"){
      NETRESOURCEW resource{};resource.dwType=RESOURCETYPE_DISK;resource.lpRemoteName=share.data();
      code=WNetAddConnection2W(&resource,username.empty()?nullptr:password.c_str(),username.empty()?nullptr:username.c_str(),0);
    }
    SecureZeroMemory(password.data(),password.size()*sizeof(wchar_t));
    std::cout<<"{\"errorCode\":"<<code<<"}";return 0;
  }catch(...){std::cout<<"{\"errorCode\":87}";return 1;}
}
